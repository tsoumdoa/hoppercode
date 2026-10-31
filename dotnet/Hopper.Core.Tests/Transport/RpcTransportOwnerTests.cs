using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hopper.Core.Dispatching;
using Hopper.Core.Protocol;
using Hopper.Core.Tests.TestDoubles;
using Hopper.Core.Transport;
using NetMQ;
using NetMQ.Sockets;
using Xunit;

namespace Hopper.Core.Tests.Transport;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class NetMqTransportCollection
{
    public const string Name = "NetMQ transport";
}

[Collection(NetMqTransportCollection.Name)]
public sealed class RpcTransportOwnerTests
{
    private const string Token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    private const string LifecycleInstanceId = "life-loopback-1";
    private static readonly DateTimeOffset Now =
        new(2026, 9, 3, 7, 0, 0, TimeSpan.Zero);

    [Fact]
    public void SharedReattachmentFencesQueuedMutationOnTheUiQueue()
    {
        using var fixture = CreateFixture(shared: true);
        using var first = ConnectDealer(fixture.RouterEndpoint, "shared-first");
        first.SendFrame(Request("handshake-first", RpcOperation.lifecycleHandshake, args: new { nodeProcessId = 12, nodeVersion = "v22.0.0", clientIdentity = "shared-first", hostEpoch = "epoch-first" }));
        var handshake = ReceiveResponse(first);
        var generation = handshake.Result.Data!.Value.GetProperty("attachmentGeneration").GetString();
        fixture.Scheduler.WaitAndRunNext();
        var request = JsonNode.Parse(Request("queued-edit", RpcOperation.runRhinoScript, "edit-wire"))!.AsObject();
        request["executionOwner"] = JsonSerializer.SerializeToNode(new { taskId = "task", turnId = "turn", attachmentGeneration = generation,
            binding = new { kind = "rhino", lifecycleInstanceId = LifecycleInstanceId, rhinoDocumentId = "doc" } });
        first.SendFrame(request.ToJsonString());
        fixture.Scheduler.WaitForPending();
        using var replacement = ConnectDealer(fixture.RouterEndpoint, "shared-next");
        replacement.SendFrame(Request("handshake-next", RpcOperation.lifecycleHandshake, args: new { nodeProcessId = 13, nodeVersion = "v22.0.0", clientIdentity = "shared-next", hostEpoch = "epoch-next" }));
        Assert.Equal(RpcResultClass.completed, ReceiveResponse(replacement).Result.Class);
        fixture.Scheduler.RunNext();
        fixture.Scheduler.WaitAndRunNext();
        Assert.NotEqual(RpcResultClass.completed, ReceiveResponse(first).Result.Class);
        Assert.Equal(0, fixture.Handler.CallCount);
        replacement.SendFrame(Request("lookup-fenced", RpcOperation.getOperationResult, args: new { operationId = "edit-wire" }));
        var retained = ReceiveResponse(replacement).Result.Data!.Value;
        Assert.Equal("terminal", retained.GetProperty("state").GetString());
        Assert.Equal("failed", retained.GetProperty("result").GetProperty("class").GetString());
    }

    [Fact]
    public void MultiplexesConcurrentRequestsOverOneDealer()
    {
        using var fixture = CreateFixture();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "node-multiplex");

        dealer.SendFrame(Request("req-first", RpcOperation.getCurrentCanvas));
        dealer.SendFrame(Request("req-second", RpcOperation.queryRhinoObjects));

        fixture.Scheduler.WaitAndRunNext();
        fixture.Scheduler.WaitAndRunNext();

        var responses = new[]
        {
            ReceiveResponse(dealer),
            ReceiveResponse(dealer),
        }.ToDictionary(response => response.RequestId);
        Assert.Equal("req-first", responses["req-first"].Result.Data?.GetString());
        Assert.Equal("req-second", responses["req-second"].Result.Data?.GetString());
        Assert.Equal(2, fixture.Handler.CallCount);
        Assert.NotNull(fixture.Owner.Status.OwnerThreadId);
        Assert.NotEqual(fixture.Owner.Status.OwnerThreadId, fixture.Handler.LastThreadId);
    }

    [Fact]
    public void ReconnectWithStableDealerIdentityReceivesPendingReply()
    {
        using var fixture = CreateFixture();
        const string identity = "stable-node-process";
        using (var first = ConnectDealer(fixture.RouterEndpoint, identity))
        {
            first.SendFrame(Request("req-reconnect", RpcOperation.getCurrentCanvas));
            fixture.Scheduler.WaitForPending();
            first.Disconnect(fixture.RouterEndpoint);
        }

        using var replacement = ConnectDealer(fixture.RouterEndpoint, identity);
        Thread.Sleep(50);
        fixture.Scheduler.RunNext();

        var response = ReceiveResponse(replacement);
        Assert.Equal("req-reconnect", response.RequestId);
        Assert.Equal(RpcResultClass.completed, response.Result.Class);
        Assert.Equal(1, fixture.Handler.CallCount);
    }

    [Fact]
    public void RejectsAuthVersionStaleInstanceAndExpiredDeadlineBeforeAdmission()
    {
        using var fixture = CreateFixture();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "node-invalid");

        var invalidAuth = Change(Request("req-auth", RpcOperation.getCurrentCanvas), "token", new string('x', 43));
        dealer.SendFrame(invalidAuth);
        AssertProtocolError(ReceiveRawResponse(dealer), "req-auth", RpcReasonCode.AUTH_INVALID);

        var wrongVersion = Change(Request("req-version", RpcOperation.getCurrentCanvas), "protocolVersion", 1);
        dealer.SendFrame(wrongVersion);
        AssertProtocolError(ReceiveRawResponse(dealer), "req-version", RpcReasonCode.PROTOCOL_VERSION_UNSUPPORTED);

        var stale = Change(Request("req-stale", RpcOperation.getCurrentCanvas), "lifecycleInstanceId", "life-old");
        dealer.SendFrame(stale);
        AssertProtocolError(ReceiveRawResponse(dealer), "req-stale", RpcReasonCode.LIFECYCLE_INSTANCE_STALE);

        dealer.SendFrame(Request(
            "req-expired",
            RpcOperation.getCurrentCanvas,
            deadline: Now.ToUnixTimeMilliseconds()));
        var expired = ReceiveResponse(dealer);
        Assert.Equal("req-expired", expired.RequestId);
        Assert.Equal(RpcResultClass.deadline_exceeded_before_start, expired.Result.Class);
        Assert.Equal(RpcReasonCode.START_DEADLINE_EXCEEDED, expired.Result.ReasonCode);

        Assert.Equal(0, fixture.Scheduler.PendingCount);
        Assert.Equal(0, fixture.Handler.CallCount);
        Assert.Equal(0, fixture.Owner.ResultStoreStatus.TotalCount);
    }

    [Fact]
    public void MutationResultIsRetainedAndLookupBypassesDispatcher()
    {
        using var fixture = CreateFixture();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "node-lookup");

        dealer.SendFrame(Request("req-mutation", RpcOperation.setSliderValue, operationId: "op-slider-1"));
        fixture.Scheduler.WaitAndRunNext();
        var mutation = ReceiveResponse(dealer);
        Assert.Equal("op-slider-1", mutation.OperationId);
        Assert.Equal(1, fixture.Owner.ResultStoreStatus.TerminalCount);

        dealer.SendFrame(Request(
            "req-lookup",
            RpcOperation.getOperationResult,
            args: new { operationId = "op-slider-1" }));
        var lookup = ReceiveResponse(dealer);
        var data = lookup.Result.Data?.Deserialize<OperationLookupDataV2>(RpcV2Contract.JsonOptions);
        Assert.Equal(OperationLookupState.terminal, data?.State);
        Assert.Equal(RpcResultClass.completed, data?.Result?.Class);
        Assert.Equal(0, fixture.Scheduler.PendingCount);
        Assert.Equal(1, fixture.Handler.CallCount);
    }

    [Fact]
    public void KeyedCancellationRetainsTheCancelledMutationOutcome()
    {
        using var fixture = CreateFixture();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "node-cancel");
        dealer.SendFrame(Request("req-cancel-target", RpcOperation.setSliderValue, operationId: "op-cancel"));
        fixture.Scheduler.WaitForPending();

        Assert.Equal(
            CancelOperationState.cancelled_before_start,
            fixture.Owner.CancelOperation("op-cancel"));
        var target = ReceiveResponse(dealer);

        Assert.Equal(RpcResultClass.cancelled_before_start, target.Result.Class);
        Assert.Equal(RpcReasonCode.CANCELLED_BEFORE_START, target.Result.ReasonCode);
        Assert.Equal(
            CancelOperationState.already_cancelled,
            fixture.Owner.CancelOperation("op-cancel"));
        Assert.Equal(
            CancelOperationState.not_found,
            fixture.Owner.CancelOperation("op-missing"));
        Assert.Equal(0, fixture.Handler.CallCount);
    }

    [Fact]
    public async Task AuthenticatedHandshakeBypassesClosedExternalAdmissionAndSignalsLifecycle()
    {
        using var fixture = CreateFixture();
        fixture.Dispatcher.CloseExternalAdmission();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "hopper-node-4242");

        dealer.SendFrame(Request(
            "req-handshake",
            RpcOperation.lifecycleHandshake,
            args: new
            {
                nodeProcessId = 4242,
                nodeVersion = "v22.19.0",
                clientIdentity = "hopper-node-4242",
            }));

        var response = ReceiveResponse(dealer);
        var data = response.Result.Data?.Deserialize<LifecycleHandshakeDataV2>(RpcV2Contract.JsonOptions);
        var handshake = await fixture.Owner.WaitForAuthenticatedHandshakeAsync(TimeSpan.FromSeconds(1));

        Assert.Equal(RpcResultClass.completed, response.Result.Class);
        Assert.Equal(HandshakeState.live, data?.Handshake);
        Assert.Equal("hopper-node-4242", handshake?.ClientIdentity);
        Assert.Equal(4242, handshake?.NodeProcessId);
        Assert.Equal(0, fixture.Scheduler.PendingCount);
        Assert.Equal(0, fixture.Handler.CallCount);
    }

    [Fact]
    public async Task HandshakeRejectsAnIdentityThatDoesNotMatchTheDealerRoute()
    {
        using var fixture = CreateFixture();
        using var dealer = ConnectDealer(fixture.RouterEndpoint, "actual-route");

        dealer.SendFrame(Request(
            "req-handshake-mismatch",
            RpcOperation.lifecycleHandshake,
            args: new
            {
                nodeProcessId = 4242,
                nodeVersion = "v22.19.0",
                clientIdentity = "claimed-route",
            }));

        var response = ReceiveResponse(dealer);
        var handshake = await fixture.Owner.WaitForAuthenticatedHandshakeAsync(TimeSpan.FromMilliseconds(20));

        Assert.Equal(RpcResultClass.failed, response.Result.Class);
        Assert.Equal(RpcReasonCode.AUTH_INVALID, response.Result.ReasonCode);
        Assert.Null(handshake);
        Assert.Equal(0, fixture.Scheduler.PendingCount);
        Assert.Equal(0, fixture.Handler.CallCount);
    }

    [Fact]
    public void StopJoinsOwnerThreadAndReleasesBothEndpoints()
    {
        using var fixture = CreateFixture(useInProcessEndpoints: true);

        var stopped = fixture.Owner.Stop(TimeSpan.FromSeconds(2));

        Assert.Equal(RpcTransportStopState.Stopped, stopped.State);
        Assert.False(fixture.Owner.Status.IsRunning);
        Assert.Equal(RpcTransportStopState.AlreadyStopped, fixture.Owner.Stop(TimeSpan.Zero).State);
        AssertEventuallyBindable(() => new RouterSocket(), fixture.RouterEndpoint);
        AssertEventuallyBindable(() => new PublisherSocket(), fixture.PublisherEndpoint);
    }

    private static Fixture CreateFixture(
        bool useInProcessEndpoints = false,
        int dispatcherCapacity = OrderedDispatcher.DefaultCapacity,
        IRpcHandshakeObserver? handshakeObserver = null,
        bool shared = false)
    {
        var scheduler = new ThreadSafeUiCallbackScheduler();
        var clock = new ManualClock(Now);
        var dispatcher = new OrderedDispatcher(scheduler, clock, dispatcherCapacity);
        var handler = new EchoHandler();
        var endpointSuffix = Guid.NewGuid().ToString("N");
        var routerEndpoint = useInProcessEndpoints
            ? $"inproc://hopper-router-{endpointSuffix}"
            : LoopbackEndpoint();
        var publisherEndpoint = useInProcessEndpoints
            ? $"inproc://hopper-publisher-{endpointSuffix}"
            : LoopbackEndpoint(except: routerEndpoint);
        var owner = new RpcTransportOwner(
            new RpcTransportOwnerOptions
            {
                RouterEndpoint = routerEndpoint,
                PublisherEndpoint = publisherEndpoint,
                ConnectionToken = Token,
                LifecycleInstanceId = LifecycleInstanceId,
                SharedMode = shared,
                SharedBindingValidator = (_, _) => null,
                SharedTransactionCleanup = (_, _) => true,
            },
            dispatcher,
            handler,
            clock,
            handshakeObserver: handshakeObserver);
        var start = owner.Start();
        Assert.Equal(RpcTransportStartState.Started, start.State);
        return new Fixture(owner, dispatcher, scheduler, handler, routerEndpoint, publisherEndpoint);
    }

    private static DealerSocket ConnectDealer(string endpoint, string identity)
    {
        var dealer = new DealerSocket();
        dealer.Options.Identity = Encoding.UTF8.GetBytes(identity);
        dealer.Options.Linger = TimeSpan.Zero;
        dealer.Connect(endpoint);
        return dealer;
    }

    private static string Request(
        string requestId,
        RpcOperation operation,
        string? operationId = null,
        long? deadline = null,
        object? args = null)
    {
        return RpcV2Contract.SerializeRequest(new RpcRequestV2
        {
            ProtocolVersion = RpcV2Contract.ProtocolVersion,
            LifecycleInstanceId = LifecycleInstanceId,
            RequestId = requestId,
            Token = Token,
            Operation = operation,
            OperationId = operationId,
            StartDeadlineAt = deadline ?? Now.AddMinutes(1).ToUnixTimeMilliseconds(),
            Args = JsonSerializer.SerializeToElement(args ?? new { }),
        });
    }

    private static string Change(string json, string property, JsonNode? value)
    {
        var request = JsonNode.Parse(json)!.AsObject();
        request[property] = value;
        return request.ToJsonString();
    }

    private static OperationResponseV2 ReceiveResponse(DealerSocket dealer)
    {
        var json = ReceiveRawResponse(dealer);
        var parsed = RpcV2Contract.ParseResponse(json);
        Assert.True(parsed.IsValid, string.Join("; ", parsed.Errors));
        return Assert.IsType<OperationResponseV2>(parsed.Value);
    }

    private static string ReceiveRawResponse(DealerSocket dealer)
    {
        Assert.True(
            dealer.TryReceiveFrameString(TimeSpan.FromSeconds(2), out var response),
            "Timed out waiting for ROUTER response.");
        return response;
    }

    private static void AssertProtocolError(string json, string requestId, RpcReasonCode reason)
    {
        var parsed = RpcV2Contract.ParseResponse(json);
        Assert.True(parsed.IsValid, string.Join("; ", parsed.Errors));
        var response = Assert.IsType<ProtocolErrorResponseV2>(parsed.Value);
        Assert.Equal(requestId, response.RequestId);
        Assert.Equal(reason, response.Result.ReasonCode);
    }

    private static string LoopbackEndpoint(string? except = null)
    {
        while (true)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var endpoint = $"tcp://127.0.0.1:{port}";
            if (endpoint != except)
                return endpoint;
        }
    }

    private static void WaitUntil(Func<bool> condition)
    {
        var timeout = Stopwatch.StartNew();
        while (!condition())
        {
            if (timeout.Elapsed >= TimeSpan.FromSeconds(2))
                throw new TimeoutException("Condition was not met before the test timeout.");
            Thread.Sleep(5);
        }
    }

    private static void AssertEventuallyBindable<TSocket>(Func<TSocket> createSocket, string endpoint)
        where TSocket : NetMQSocket
    {
        Exception? lastError = null;
        var timeout = Stopwatch.StartNew();
        while (timeout.Elapsed < TimeSpan.FromSeconds(2))
        {
            using var socket = createSocket();
            socket.Options.Linger = TimeSpan.Zero;
            try
            {
                socket.Bind(endpoint);
                socket.Unbind(endpoint);
                return;
            }
            catch (AddressAlreadyInUseException exception)
            {
                lastError = exception;
                Thread.Sleep(5);
            }
        }
        throw new Xunit.Sdk.XunitException($"Endpoint was not released: {endpoint}. {lastError?.Message}");
    }

    private sealed class EchoHandler : IRpcOperationHandler
    {
        private int _callCount;
        private int _lastThreadId;

        public int CallCount => Volatile.Read(ref _callCount);
        public int LastThreadId => Volatile.Read(ref _lastThreadId);

        public OperationResultV2 Execute(RpcRequestV2 request)
        {
            Interlocked.Increment(ref _callCount);
            Volatile.Write(ref _lastThreadId, Environment.CurrentManagedThreadId);
            return new OperationResultV2
            {
                Class = RpcResultClass.completed,
                ReasonCode = RpcReasonCode.OK,
                Data = JsonSerializer.SerializeToElement(request.RequestId),
            };
        }
    }

    private sealed class HandshakeObserver : IRpcHandshakeObserver
    {
        private readonly RpcHandshakeObservation _result;

        public HandshakeObserver(RpcHandshakeObservation result)
        {
            _result = result;
        }

        public int CallCount { get; private set; }

        public RpcHandshakeObservation OnAuthenticatedHandshake(LifecycleHandshakeArgsV2 handshake)
        {
            CallCount++;
            return _result;
        }
    }

    private sealed class ThreadSafeUiCallbackScheduler : IUiCallbackScheduler
    {
        private readonly ConcurrentQueue<Action> _callbacks = new();
        private readonly SemaphoreSlim _available = new(0);

        public int PendingCount => _callbacks.Count;

        public void Post(Action callback)
        {
            _callbacks.Enqueue(callback);
            _available.Release();
        }

        public void WaitForPending()
        {
            Assert.True(_available.Wait(TimeSpan.FromSeconds(2)), "Dispatcher callback was not posted.");
        }

        public void WaitAndRunNext()
        {
            WaitForPending();
            RunNext();
        }

        public void RunNext()
        {
            Assert.True(_callbacks.TryDequeue(out var callback), "Dispatcher callback queue was empty.");
            callback();
        }
    }

    private sealed record Fixture(
        RpcTransportOwner Owner,
        OrderedDispatcher Dispatcher,
        ThreadSafeUiCallbackScheduler Scheduler,
        EchoHandler Handler,
        string RouterEndpoint,
        string PublisherEndpoint) : IDisposable
    {
        public void Dispose()
        {
            Owner.Dispose();
        }
    }
}
