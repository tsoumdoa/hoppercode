using Hopper.Core;
using Xunit;

namespace Hopper.Core.Tests;

public class MutationResultStoreTests
{

    [Fact]
    public void DuplicateTerminalAdmissionReturnsStoredResultWithoutExecutingAgain()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "same");
        var first = fixture.Store.Complete("same", Result("first"));

        var duplicate = fixture.Store.Admit(OperationRetentionKind.Mutation, "same");
        var secondCompletion = fixture.Store.Complete("same", Result("replacement"));

        Assert.Equal(MutationAdmissionState.ExistingTerminal, duplicate.State);
        Assert.Equal(first.TerminalResult, duplicate.TerminalResult);
        Assert.Equal(MutationCompletionState.ExistingTerminal, secondCompletion.State);
        Assert.Equal("first", secondCompletion.TerminalResult!.Body);
        Assert.Equal(5, secondCompletion.Snapshot.UsedBytes);
    }

    [Fact]
    public void OversizedResultBecomesCompactRetainedTerminalFailure()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "operation-1");

        var completion = fixture.Store.Complete("operation-1", Result(new string('a', 65_537)));

        Assert.Equal(MutationCompletionState.ResultTooLarge, completion.State);
        Assert.Equal(OversizedTerminalBody, completion.TerminalResult!.Body);
        Assert.Equal(MutationLookupState.Terminal, fixture.Store.Lookup("operation-1").State);
        Assert.Equal(OversizedTerminalBody.Length, fixture.Store.GetSnapshot().UsedBytes);
        Assert.Equal(
            MutationAdmissionState.ExistingTerminal,
            fixture.Store.Admit(OperationRetentionKind.Mutation, "operation-1").State);
    }

    [Fact]
    public void SerializerFailureLeavesOperationPending()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "operation-1");
        fixture.Serializer.Exception = new InvalidOperationException("serialization failed");

        Assert.Throws<InvalidOperationException>(() => fixture.Store.Complete("operation-1", Result("unused")));
        Assert.Equal(MutationLookupState.Pending, fixture.Store.Lookup("operation-1").State);
    }

    [Fact]
    public void InFlightReservationsNeverExpire()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "pending");

        fixture.Clock.Advance(TimeSpan.FromDays(30));

        Assert.Equal(0, fixture.Store.RemoveExpired());
        Assert.Equal(MutationLookupState.Pending, fixture.Store.Lookup("pending").State);
        Assert.Equal(65_536, fixture.Store.GetSnapshot().UsedBytes);
    }

    [Fact]
    public void CleanupReleasesOnlyInFlightReservationsAndRejectsLateCompletion()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "terminal");
        fixture.Store.Complete("terminal", Result("done"));
        fixture.Store.Admit(OperationRetentionKind.Mutation, "pending-1");
        fixture.Store.Admit(OperationRetentionKind.Mutation, "pending-2");

        Assert.True(fixture.Store.ReleaseInFlight("pending-1"));
        Assert.False(fixture.Store.ReleaseInFlight("terminal"));
        Assert.Equal(1, fixture.Store.ReleaseAllInFlight());

        var snapshot = fixture.Store.GetSnapshot();
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(1, snapshot.TerminalCount);
        Assert.Equal(4, snapshot.UsedBytes);
        Assert.Equal(MutationLookupState.NotFound, fixture.Store.Lookup("pending-1").State);
        Assert.Equal(MutationLookupState.NotFound, fixture.Store.Lookup("pending-2").State);
        Assert.Equal(
            MutationCompletionState.NotFound,
            fixture.Store.Complete("pending-1", Result("late")).State);
    }

    [Fact]
    public void ConcurrentDuplicateAdmissionsCreateOneReservation()
    {
        var fixture = Fixture();
        var states = new MutationAdmissionState[64];

        Parallel.For(0, states.Length, index =>
        {
            states[index] = fixture.Store.Admit(OperationRetentionKind.Mutation, "same").State;
        });

        Assert.Equal(1, states.Count(state => state == MutationAdmissionState.Admitted));
        Assert.Equal(63, states.Count(state => state == MutationAdmissionState.ExistingPending));
        Assert.Equal(1, fixture.Store.GetSnapshot().InFlightCount);
        Assert.Equal(65_536, fixture.Store.GetSnapshot().UsedBytes);
    }

    [Fact]
    public void ConcurrentCompletionsRetainExactlyOneTerminalResult()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "same");
        var completions = new MutationCompletionResult[32];

        Parallel.For(0, completions.Length, index =>
        {
            completions[index] = fixture.Store.Complete("same", Result($"result-{index}"));
        });

        Assert.Equal(1, completions.Count(result => result.State == MutationCompletionState.Completed));
        Assert.Equal(31, completions.Count(result => result.State == MutationCompletionState.ExistingTerminal));
        var stored = fixture.Store.Lookup("same").TerminalResult!;
        Assert.All(completions, result => Assert.Equal(stored, result.TerminalResult));
        Assert.Equal(stored.ByteCount, fixture.Store.GetSnapshot().UsedBytes);
    }

    [Fact]
    public async Task CleanupCanWinRaceWhileCompletionSerializesWithoutLeakingReservation()
    {
        var fixture = Fixture();
        fixture.Store.Admit(OperationRetentionKind.Mutation, "racing");
        using var serializerEntered = new ManualResetEventSlim();
        using var allowSerializerToReturn = new ManualResetEventSlim();
        fixture.Serializer.OnSerialize = result =>
        {
            serializerEntered.Set();
            allowSerializerToReturn.Wait();
            return new SerializedMutationResult(result.Body);
        };

        var completionTask = Task.Run(() => fixture.Store.Complete("racing", Result("late")));
        serializerEntered.Wait();
        Assert.True(fixture.Store.ReleaseInFlight("racing"));
        allowSerializerToReturn.Set();
        var completion = await completionTask;

        Assert.Equal(MutationCompletionState.NotFound, completion.State);
        Assert.Equal(0, fixture.Store.GetSnapshot().TotalCount);
        Assert.Equal(0, fixture.Store.GetSnapshot().UsedBytes);
    }

    private const string OversizedTerminalBody = "{\"class\":\"failed\",\"reasonCode\":\"OPERATION_RESULT_TOO_LARGE\"}";

    private static TestResult Result(string body) => new(body);

    private static StoreFixture Fixture(MutationResultStoreOptions? options = null)
    {
        var clock = new FakeClock(new DateTimeOffset(2026, 9, 3, 0, 0, 0, TimeSpan.Zero));
        var serializer = new FakeSerializer();
        return new StoreFixture(
            new MutationResultStore<TestResult>(
                clock,
                serializer,
                new OperationResultTooLargeTerminal(OversizedTerminalBody),
                options),
            clock,
            serializer);
    }

    private sealed record StoreFixture(
        MutationResultStore<TestResult> Store,
        FakeClock Clock,
        FakeSerializer Serializer);

    private sealed record TestResult(string Body);

    private sealed class FakeClock(DateTimeOffset now) : IMutationResultStoreClock
    {
        public DateTimeOffset UtcNow { get; private set; } = now;
        public void Advance(TimeSpan duration) => UtcNow += duration;
    }

    private sealed class FakeSerializer : IMutationResultSerializer<TestResult>
    {
        public Exception? Exception { get; set; }
        public Func<TestResult, SerializedMutationResult>? OnSerialize { get; set; }

        public SerializedMutationResult Serialize(TestResult result)
        {
            if (Exception is not null)
                throw Exception;
            return OnSerialize?.Invoke(result) ?? new SerializedMutationResult(result.Body);
        }
    }
}
