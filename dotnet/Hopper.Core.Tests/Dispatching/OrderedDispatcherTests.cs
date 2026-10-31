using Hopper.Core.Dispatching;
using Hopper.Core.Tests.TestDoubles;
using Xunit;

namespace Hopper.Core.Tests.Dispatching;

public class OrderedDispatcherTests
{
    private static readonly DateTimeOffset InitialTime =
        new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);

    [Fact]
    public async Task ExternalWorkRunsFifoOneItemPerSchedulerCallback()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock, capacity: 3);
        var order = new List<int>();
        var deadline = clock.UtcNow.AddMinutes(1);

        var first = dispatcher.SubmitExternal(() => Record(order, 1), deadline);
        var second = dispatcher.SubmitExternal(() => Record(order, 2), deadline);
        var third = dispatcher.SubmitExternal(() => Record(order, 3), deadline);

        Assert.Equal(1, scheduler.PendingCount);
        scheduler.RunNext();
        Assert.Equal(new[] { 1 }, order);
        Assert.True(first.IsCompletedSuccessfully);
        Assert.False(second.IsCompleted);
        Assert.Equal(1, scheduler.PendingCount);

        scheduler.RunNext();
        Assert.Equal(new[] { 1, 2 }, order);
        Assert.True(second.IsCompletedSuccessfully);
        Assert.False(third.IsCompleted);
        Assert.Equal(1, scheduler.PendingCount);

        scheduler.RunNext();
        Assert.Equal(new[] { 1, 2, 3 }, order);
        Assert.Equal(0, scheduler.PendingCount);
        var result = await third;
        Assert.Equal(DispatcherResultKind.Completed, result.Kind);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public async Task DeadlineIsCheckedAgainBeforeWorkStarts()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock);
        var invoked = false;
        var completion = dispatcher.SubmitExternal(
            () => invoked = true,
            clock.UtcNow.AddSeconds(5));

        clock.Advance(TimeSpan.FromSeconds(5));
        scheduler.RunNext();

        Assert.False(invoked);
        Assert.Equal(DispatcherResultKind.DeadlineExceededBeforeStart, (await completion).Kind);
    }

    [Fact]
    public async Task CancellationRemovesQueuedWorkBeforeItStarts()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock);
        using var cancellation = new CancellationTokenSource();
        var invoked = false;
        var completion = dispatcher.SubmitExternal(
            () => invoked = true,
            clock.UtcNow.AddMinutes(1),
            cancellation.Token);

        cancellation.Cancel();

        Assert.Equal(DispatcherResultKind.CancelledBeforeStart, (await completion).Kind);
        Assert.Equal(0, dispatcher.Status.ExternalDepth);
        scheduler.RunNext();
        Assert.False(invoked);
    }

    [Fact]
    public async Task LifecycleControlUsesReservedCapacityAfterExternalAdmissionCloses()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock, capacity: 1);
        var deadline = clock.UtcNow.AddMinutes(1);
        var external = dispatcher.SubmitExternal(() => "external", deadline);
        Assert.Equal(
            DispatcherResultKind.Busy,
            (await dispatcher.SubmitExternal(() => "overflow", deadline)).Kind);

        dispatcher.CloseExternalAdmission();
        var rejected = await dispatcher.SubmitExternal(() => "closed", deadline);
        var lifecycle = dispatcher.SubmitLifecycleControl(() => "stop");

        Assert.Equal(DispatcherResultKind.ShuttingDown, rejected.Kind);
        Assert.False(lifecycle.IsCompleted);
        Assert.Equal(1, dispatcher.Status.ExternalDepth);
        Assert.Equal(1, dispatcher.Status.LifecycleDepth);

        scheduler.RunNext();
        Assert.Equal("stop", (await lifecycle).Value);
        Assert.False(external.IsCompleted);

        Assert.True(dispatcher.ReopenExternalAdmission());
        scheduler.RunNext();
        Assert.Equal("external", (await external).Value);

        var reopened = dispatcher.SubmitExternal(() => "reopened", deadline);
        scheduler.RunNext();
        Assert.Equal("reopened", (await reopened).Value);
    }

    [Fact]
    public async Task KeyedCancellationRemovesOnlyTheMatchingQueuedOperation()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock);
        var deadline = clock.UtcNow.AddMinutes(1);
        var first = dispatcher.SubmitExternal(() => 1, deadline, operationId: "op-first");
        var second = dispatcher.SubmitExternal(() => 2, deadline, operationId: "op-second");

        var cancellation = dispatcher.CancelQueuedExternal("op-second");

        Assert.Equal(DispatcherCancellationState.CancelledBeforeStart, cancellation);
        Assert.Equal(DispatcherResultKind.CancelledBeforeStart, (await second).Kind);
        Assert.False(first.IsCompleted);
        scheduler.RunNext();
        Assert.Equal(1, (await first).Value);
    }

    [Fact]
    public void LifecycleControlRunsAfterCurrentItemAndBeforeQueuedExternalWork()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock, capacity: 2);
        var deadline = clock.UtcNow.AddMinutes(1);
        var order = new List<string>();
        Task<DispatcherResult<string>>? lifecycle = null;

        dispatcher.SubmitExternal(() =>
        {
            order.Add("running");
            dispatcher.CloseExternalAdmission();
            lifecycle = dispatcher.SubmitLifecycleControl(() => Record(order, "lifecycle"));
            return "running";
        }, deadline);
        var queued = dispatcher.SubmitExternal(() => Record(order, "queued"), deadline);

        scheduler.RunNext();
        Assert.Equal(new[] { "running" }, order);
        Assert.NotNull(lifecycle);
        Assert.False(lifecycle.IsCompleted);
        Assert.False(queued.IsCompleted);

        scheduler.RunNext();
        Assert.Equal(new[] { "running", "lifecycle" }, order);
        Assert.True(lifecycle.IsCompletedSuccessfully);
        Assert.False(queued.IsCompleted);

        scheduler.RunNext();
        Assert.Equal(new[] { "running", "lifecycle", "queued" }, order);
    }

    [Fact]
    public async Task ShutdownRejectsNewWorkAndCompletesQueuedWork()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock);
        var deadline = clock.UtcNow.AddMinutes(1);
        var queued = dispatcher.SubmitExternal(() => 1, deadline);

        dispatcher.Shutdown();

        Assert.Equal(DispatcherResultKind.ShuttingDown, (await queued).Kind);
        Assert.Equal(
            DispatcherResultKind.ShuttingDown,
            (await dispatcher.SubmitExternal(() => 2, deadline)).Kind);
        Assert.Equal(
            DispatcherResultKind.ShuttingDown,
            (await dispatcher.SubmitLifecycleControl(() => 3)).Kind);
        Assert.False(dispatcher.ReopenExternalAdmission());
        Assert.True(dispatcher.Status.IsShutdown);
    }

    [Fact]
    public async Task ThrowingStatusObserverCannotStallQueuedWork()
    {
        var scheduler = new ManualUiCallbackScheduler();
        var clock = new ManualClock(InitialTime);
        var dispatcher = new OrderedDispatcher(scheduler, clock);
        dispatcher.StatusChanged += _ => throw new InvalidOperationException("observer failed");

        var first = dispatcher.SubmitExternal(() => 1, clock.UtcNow.AddMinutes(1));
        var second = dispatcher.SubmitExternal(() => 2, clock.UtcNow.AddMinutes(1));
        scheduler.RunNext();
        scheduler.RunNext();

        Assert.Equal(1, (await first).Value);
        Assert.Equal(2, (await second).Value);
    }

    private static T Record<T>(ICollection<T> order, T value)
    {
        order.Add(value);
        return value;
    }
}
