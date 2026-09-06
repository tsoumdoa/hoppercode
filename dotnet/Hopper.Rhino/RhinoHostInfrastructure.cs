using System;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Hopper.Core;
using Hopper.Core.Dispatching;
using Hopper.Core.Lifecycle;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Hopper.Core.Runtime;
using Hopper.Core.Time;
using Hopper.Core.Transport;
using Hopper.Rhino.Host;
using Rhino;

namespace rhino_zmq_poc
{
    internal sealed class RhinoUiCallbackScheduler : IUiCallbackScheduler
    {
        public void Post(Action callback)
        {
            if (callback == null)
                throw new ArgumentNullException(nameof(callback));
            RhinoApp.InvokeOnUiThread(callback);
        }
    }

    internal sealed class RhinoCommandCompletionSink : IHopperCommandCompletionSink
    {
        private readonly ILifecycleDispatcher _dispatcher;

        public RhinoCommandCompletionSink(ILifecycleDispatcher dispatcher)
        {
            _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        }

        public void Write(string message)
        {
            if (string.IsNullOrWhiteSpace(message))
                return;
            _ = _dispatcher.SubmitLifecycleControl(() => RhinoApp.WriteLine(message));
        }
    }

    internal sealed class RhinoDispatcherExecutionObserver
    {
        private readonly RuntimeStatusStore _status;

        public RhinoDispatcherExecutionObserver(RuntimeStatusStore status)
        {
            _status = status ?? throw new ArgumentNullException(nameof(status));
        }

        public void Record(DispatcherExecutionRecord execution)
        {
            if (!execution.IsSlow)
                return;

            var milliseconds = Math.Ceiling(execution.Duration.TotalMilliseconds);
            var work = execution.IsLifecycleControl ? "lifecycle" : "external";
            var operation = string.IsNullOrWhiteSpace(execution.OperationId)
                ? string.Empty
                : $" ({execution.OperationId})";
            var message = $"Hopper UI dispatcher {work} callback{operation} took {milliseconds} ms.";
            _status.UpdateError(RuntimeStatusComponent.Dispatcher, new RuntimeErrorV2
            {
                Code = RpcReasonCode.OPERATION_FAILED,
                Message = message,
            });
            RhinoApp.WriteLine($"Warning: {message}");
        }
    }

    internal sealed class RhinoGrasshopperStartController : IGrasshopperStartController
    {
        public bool StartGrasshopper() => RhinoApp.RunScript("_Grasshopper", echo: false);
    }

    internal sealed class GuidLifecycleInstanceIdSource : ILifecycleInstanceIdSource
    {
        public string Create() => Guid.NewGuid().ToString("N");
    }

    internal sealed class LoopbackEndpointSource
    {
        public (string Router, string Publisher) Create()
        {
            var router = CreateOne();
            string publisher;
            do
            {
                publisher = CreateOne();
            } while (string.Equals(router, publisher, StringComparison.Ordinal));
            return (router, publisher);
        }

        private static string CreateOne()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            try
            {
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                return $"tcp://127.0.0.1:{port}";
            }
            finally
            {
                listener.Stop();
            }
        }
    }

    internal sealed class DeferredRpcOperationHandler : IRpcOperationHandler
    {
        private IRpcOperationHandler _target;

        public void SetTarget(IRpcOperationHandler target)
        {
            if (target == null)
                throw new ArgumentNullException(nameof(target));
            if (Interlocked.CompareExchange(ref _target, target, null) != null)
                throw new InvalidOperationException("The RPC operation handler is already configured.");
        }

        public OperationResultV2 Execute(RpcRequestV2 request)
        {
            var target = Volatile.Read(ref _target);
            return target != null
                ? target.Execute(request)
                : new OperationResultV2
                {
                    Class = RpcResultClass.shutting_down,
                    ReasonCode = RpcReasonCode.SHUTTING_DOWN,
                    Message = "The Rhino host is not configured.",
                };
        }
    }

    internal sealed class RpcLifecycleTransport :
        ILifecycleTransport,
        IRpcHandshakeObserver,
        IHopperOperationCancellation,
        IRuntimeStatusWakeupPublisher,
        IDisposable
    {
        private readonly object _gate = new object();
        private readonly OrderedDispatcher _dispatcher;
        private readonly IRpcOperationHandler _operations;
        private readonly RuntimeStatusStore _status;
        private readonly IHopperClock _clock;
        private readonly LoopbackEndpointSource _endpoints;
        private RpcTransportOwner _owner;
        private string _instanceId;

        public RpcLifecycleTransport(
            OrderedDispatcher dispatcher,
            IRpcOperationHandler operations,
            RuntimeStatusStore status,
            IHopperClock clock,
            LoopbackEndpointSource endpoints)
        {
            _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
            _operations = operations ?? throw new ArgumentNullException(nameof(operations));
            _status = status ?? throw new ArgumentNullException(nameof(status));
            _clock = clock ?? throw new ArgumentNullException(nameof(clock));
            _endpoints = endpoints ?? throw new ArgumentNullException(nameof(endpoints));
        }

        public bool IsRunning
        {
            get
            {
                lock (_gate)
                    return _owner?.Status.IsRunning == true;
            }
        }

        public Task<TransportStartResult> StartAsync(
            string lifecycleInstanceId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var endpoints = _endpoints.Create();
            var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
                .TrimEnd('=')
                .Replace('+', '-')
                .Replace('/', '_');
            var owner = new RpcTransportOwner(
                new RpcTransportOwnerOptions
                {
                    RouterEndpoint = endpoints.Router,
                    PublisherEndpoint = endpoints.Publisher,
                    ConnectionToken = token,
                    LifecycleInstanceId = lifecycleInstanceId,
                },
                _dispatcher,
                _operations,
                _clock,
                handshakeObserver: this);

            lock (_gate)
            {
                if (_owner?.Status.IsRunning == true)
                {
                    owner.Dispose();
                    return Task.FromResult(new TransportStartResult(
                        false, false, null, "A transport owner is already running."));
                }
                _owner?.Dispose();
                _owner = owner;
                _instanceId = lifecycleInstanceId;
            }

            var start = owner.Start();
            if (start.State != RpcTransportStartState.Started)
            {
                owner.Dispose();
                lock (_gate)
                {
                    if (ReferenceEquals(_owner, owner))
                        _owner = null;
                }
                return Task.FromResult(new TransportStartResult(
                    false,
                    false,
                    null,
                    start.Error ?? $"Transport startup returned {start.State}."));
            }

            Hopper.Core.Operations.DocumentSession.Start(lifecycleInstanceId);
            _status.UpdateTransport(true, lifecycleInstanceId);
            return Task.FromResult(new TransportStartResult(
                true,
                true,
                new LifecycleTransportConnection(endpoints.Router, endpoints.Publisher, token),
                ""));
        }

        public async Task<LifecycleActionResult> WaitForAuthenticatedHandshakeAsync(
            string lifecycleInstanceId,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            RpcTransportOwner owner;
            lock (_gate)
            {
                if (!string.Equals(_instanceId, lifecycleInstanceId, StringComparison.Ordinal)
                    || _owner == null)
                {
                    return LifecycleActionResult.Failure("The transport lifecycle instance is not active.");
                }
                owner = _owner;
            }

            var handshake = await owner.WaitForAuthenticatedHandshakeAsync(timeout, cancellationToken)
                .ConfigureAwait(false);
            return handshake == null
                ? LifecycleActionResult.Failure("Authenticated transport handshake timed out.")
                : LifecycleActionResult.Success();
        }

        public Task<bool> StopAsync(TimeSpan timeout, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RpcTransportOwner owner;
            lock (_gate)
                owner = _owner;
            if (owner == null)
                return Task.FromResult(true);

            var stopped = owner.Stop(timeout);
            var success = stopped.State is RpcTransportStopState.Stopped or RpcTransportStopState.AlreadyStopped;
            if (success)
            {
                _status.UpdateTransport(false, null);
                lock (_gate)
                {
                    if (ReferenceEquals(_owner, owner))
                    {
                        _owner = null;
                        _instanceId = null;
                    }
                }
                owner.Dispose();
            }
            return Task.FromResult(success);
        }

        public void SignalStopNoWait()
        {
            RpcTransportOwner owner;
            lock (_gate)
                owner = _owner;
            owner?.Stop(TimeSpan.Zero);
        }

        public RpcHandshakeObservation OnAuthenticatedHandshake(LifecycleHandshakeArgsV2 handshake)
        {
            var acceptance = _status.TryAcceptInitialHostHandshake(
                handshake.NodeProcessId,
                handshake.NodeVersion);
            return acceptance.Accepted
                ? RpcHandshakeObservation.Allow(acceptance.StatusRevision)
                : RpcHandshakeObservation.Reject(
                    "The handshake process ID does not match the managed Node child.");
        }

        public CancelOperationState Cancel(string operationId)
        {
            RpcTransportOwner owner;
            lock (_gate)
                owner = _owner;
            return owner == null
                ? CancelOperationState.not_found
                : owner.CancelOperation(operationId);
        }

        public void PublishStatusChanged(long revision)
        {
            if (revision < 0)
                throw new ArgumentOutOfRangeException(nameof(revision));

            RpcTransportOwner owner;
            lock (_gate)
                owner = _owner;
            if (owner == null)
                return;

            owner.Publish(
                RuntimeStatusWakeup.Topic,
                JsonSerializer.Serialize(new RuntimeStatusWakeupV2
                {
                    ProtocolVersion = RpcV2Contract.ProtocolVersion,
                    Revision = revision,
                }, RpcV2Contract.JsonOptions));
        }

        public void Dispose()
        {
            SignalStopNoWait();
        }

    }
}
