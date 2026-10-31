using System.Collections.Concurrent;
using Hopper.Core;
using Xunit;

namespace Hopper.Core.Tests;

public class InstanceProfilePolicyTests
{
    private static readonly DateTimeOffset StartedAt =
        new(2026, 8, 1, 10, 0, 0, TimeSpan.Zero);

    private static readonly DateTimeOffset CreatedAt =
        new(2026, 8, 1, 10, 0, 1, TimeSpan.Zero);

    [Fact]
    public void CompatibilityPointerFailureDoesNotUndoAuthoritativeProfile()
    {
        var fileSystem = new FakeFileSystem { FailMoveDestination = "/connection.json" };
        var store = new InstanceProfileStore(fileSystem, new IncrementingTemporaryPaths());

        var result = store.Write(Profile(), "/instances/a/profile.json", "/connection.json");

        Assert.False(result.CompatibilityPointerWritten);
        Assert.NotNull(result.CompatibilityPointerError);
        Assert.True(fileSystem.Files.ContainsKey("/instances/a/profile.json"));
        Assert.False(fileSystem.Files.ContainsKey("/connection.json"));
        Assert.DoesNotContain(fileSystem.Files.Keys, path => path.EndsWith(".tmp", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompatibilityPointerIsAtomicLastSuccessfulWriterWins()
    {
        var fileSystem = new FakeFileSystem();
        var paths = new IncrementingTemporaryPaths();
        var storeA = new InstanceProfileStore(fileSystem, paths);
        var storeB = new InstanceProfileStore(fileSystem, paths);

        await Task.WhenAll(
            Task.Run(() => storeA.Write(
                Profile(instanceId: "instance-a"),
                "/instances/a/profile.json",
                "/connection.json")),
            Task.Run(() => storeB.Write(
                Profile(instanceId: "instance-b", processId: 5252),
                "/instances/b/profile.json",
                "/connection.json")));

        Assert.True(InstanceProfileCodec.TryDeserialize(
            fileSystem.Files["/connection.json"], out var pointer));
        Assert.Contains(pointer!.LifecycleInstanceId, new[] { "instance-a", "instance-b" });
        Assert.True(fileSystem.Files.ContainsKey("/instances/a/profile.json"));
        Assert.True(fileSystem.Files.ContainsKey("/instances/b/profile.json"));
        Assert.DoesNotContain(fileSystem.Files.Keys, path => path.EndsWith(".tmp", StringComparison.Ordinal));
    }

    [Fact]
    public void ActiveProfileAndLogsAreNeverDeletedBasedOnAge()
    {
        var fixture = Fixture(Running(StartedAt));
        fixture.Clock.UtcNow = CreatedAt.AddYears(20);

        var result = fixture.Policy.Cleanup(Paths());

        Assert.Equal(InstanceProfileOwnershipState.Active, result.OwnershipState);
        Assert.False(result.ProfileDeleted);
        Assert.False(result.LogsDeleted);
        Assert.True(fixture.FileSystem.FileExists("/instances/a/profile.json"));
        Assert.True(fixture.FileSystem.DirectoryExists("/instances/a/logs"));
    }

    [Fact]
    public void UninspectableProcessKeepsProfileAndLogs()
    {
        var fixture = Fixture(new ProcessIdentityObservation(ProcessInspectionState.Uninspectable));

        var result = fixture.Policy.Cleanup(Paths());

        Assert.Equal(InstanceProfileOwnershipState.Uninspectable, result.OwnershipState);
        Assert.False(result.ProfileDeleted);
        Assert.False(result.LogsDeleted);
        Assert.True(fixture.FileSystem.FileExists("/instances/a/profile.json"));
    }

    [Fact]
    public void FailedDeathMarkerWriteKeepsProfileAndLogs()
    {
        var fixture = Fixture(new ProcessIdentityObservation(ProcessInspectionState.NotRunning));
        fixture.FileSystem.FailMoveDestination = "/instances/a/verified-dead.json";

        var result = fixture.Policy.Cleanup(Paths());

        Assert.Equal(InstanceProfileOwnershipState.VerifiedDead, result.OwnershipState);
        Assert.False(result.ProfileDeleted);
        Assert.False(result.LogsDeleted);
        Assert.False(result.VerifiedDeadMarkerWritten);
        Assert.True(fixture.FileSystem.FileExists("/instances/a/profile.json"));
    }

    [Fact]
    public void DeathMarkerCannotDeleteAReplacementProfile()
    {
        var fixture = Fixture(new ProcessIdentityObservation(ProcessInspectionState.NotRunning));
        fixture.Policy.Cleanup(Paths());
        fixture.FileSystem.Files["/instances/a/profile.json"] =
            InstanceProfileCodec.Serialize(Profile(processId: 9999, instanceId: "replacement"));
        fixture.Clock.UtcNow += TimeSpan.FromDays(8);

        var result = fixture.Policy.Cleanup(Paths());

        Assert.Equal(InstanceProfileOwnershipState.Replaced, result.OwnershipState);
        Assert.False(result.ProfileDeleted);
        Assert.False(result.LogsDeleted);
        Assert.True(fixture.FileSystem.FileExists("/instances/a/profile.json"));
        Assert.True(fixture.FileSystem.DirectoryExists("/instances/a/logs"));
    }

    [Fact]
    public void CleanupOnlyDeletesExplicitEphemeralLogsPath()
    {
        var fixture = Fixture(new ProcessIdentityObservation(ProcessInspectionState.NotRunning));
        fixture.FileSystem.Directories.TryAdd("/workspace", 0);
        fixture.FileSystem.Files.TryAdd("/workspace/conversation.json", "keep");
        fixture.Policy.Cleanup(Paths());
        fixture.Clock.UtcNow += TimeSpan.FromDays(7);

        fixture.Policy.Cleanup(Paths());

        Assert.True(fixture.FileSystem.DirectoryExists("/workspace"));
        Assert.True(fixture.FileSystem.FileExists("/workspace/conversation.json"));
        Assert.Equal(new[] { "/instances/a/logs" }, fixture.FileSystem.DeletedDirectories);
    }

    [Fact]
    public void DirectoryScannerPreservesActiveMalformedAndUninspectableProfilesAndDeletesDeadProfile()
    {
        var fileSystem = new FakeFileSystem();
        var directory = Path.Combine(Path.GetTempPath(), "profile-policy-tests");
        string Entry(string name) => Path.Combine(directory, name);
        fileSystem.Directories.TryAdd(directory, 0);
        fileSystem.Files[Entry("active.json")] = InstanceProfileCodec.Serialize(
            Profile(processId: 1001, instanceId: "active"));
        fileSystem.Files[Entry("dead.json")] = InstanceProfileCodec.Serialize(
            Profile(processId: 1002, instanceId: "dead"));
        fileSystem.Files[Entry("malformed.json")] = "not-json";
        fileSystem.Files[Entry("uninspectable.json")] = InstanceProfileCodec.Serialize(
            Profile(processId: 1003, instanceId: "uninspectable"));
        var processes = new MappedProcessInspector(new Dictionary<int, ProcessIdentityObservation>
        {
            [1001] = Running(StartedAt),
            [1002] = new(ProcessInspectionState.NotRunning),
            [1003] = new(ProcessInspectionState.Uninspectable),
        });
        var scanner = new InstanceProfileDirectoryScanner(
            fileSystem,
            processes,
            new FakeClock { UtcNow = CreatedAt.AddMinutes(1) },
            new IncrementingTemporaryPaths());

        var report = scanner.Scan(directory);

        Assert.Null(report.Error);
        Assert.Equal(
            new[]
            {
                InstanceProfileOwnershipState.Active,
                InstanceProfileOwnershipState.VerifiedDead,
                InstanceProfileOwnershipState.Malformed,
                InstanceProfileOwnershipState.Uninspectable,
            },
            report.Entries.Select(entry => entry.Cleanup.OwnershipState));
        Assert.True(fileSystem.FileExists(Entry("active.json")));
        Assert.False(fileSystem.FileExists(Entry("dead.json")));
        Assert.True(fileSystem.FileExists(Entry("dead.verified-dead.json")));
        Assert.True(fileSystem.FileExists(Entry("malformed.json")));
        Assert.True(fileSystem.FileExists(Entry("uninspectable.json")));
    }

    [Fact]
    public void DirectoryScannerRevisitsMarkerAndDeletesOnlyAgedEphemeralLogs()
    {
        var fileSystem = new FakeFileSystem();
        var directory = Path.Combine(Path.GetTempPath(), "profile-policy-tests");
        string Entry(string name) => Path.Combine(directory, name);
        fileSystem.Directories.TryAdd(directory, 0);
        fileSystem.Directories.TryAdd(Entry("dead.logs"), 0);
        fileSystem.Files[Entry("dead.json")] = InstanceProfileCodec.Serialize(
            Profile(processId: 1002, instanceId: "dead"));
        var clock = new FakeClock { UtcNow = CreatedAt.AddMinutes(1) };
        var scanner = new InstanceProfileDirectoryScanner(
            fileSystem,
            new MappedProcessInspector(new Dictionary<int, ProcessIdentityObservation>
            {
                [1002] = new(ProcessInspectionState.NotRunning),
            }),
            clock,
            new IncrementingTemporaryPaths());

        scanner.Scan(directory);
        clock.UtcNow += InstanceProfileRetentionPolicy.EphemeralLogRetention;
        var report = scanner.Scan(directory);

        Assert.Single(report.Entries);
        Assert.True(report.Entries[0].Cleanup.LogsDeleted);
        Assert.False(fileSystem.DirectoryExists(Entry("dead.logs")));
        Assert.False(fileSystem.FileExists(Entry("dead.verified-dead.json")));
    }

    private static InstanceConnectionProfile Profile(
        int processId = 4242,
        string instanceId = "instance-a") =>
        new(
            ProtocolVersion: 2,
            OwnerProcessId: processId,
            OwnerProcessStartedAt: StartedAt,
            LifecycleInstanceId: instanceId,
            CreatedAt: CreatedAt,
            Endpoints: new InstanceProfileEndpoints(
                "tcp://127.0.0.1:32001",
                "tcp://127.0.0.1:32002"),
            Authentication: new InstanceProfileAuthentication("secret-token"));

    private static InstanceProfilePaths Paths() =>
        new(
            "/instances/a/profile.json",
            "/instances/a/logs",
            "/instances/a/verified-dead.json");

    private static ProcessIdentityObservation Running(DateTimeOffset startedAt) =>
        new(ProcessInspectionState.Running, startedAt);

    private static PolicyFixture Fixture(ProcessIdentityObservation process)
    {
        var fileSystem = new FakeFileSystem();
        fileSystem.Files.TryAdd(
            "/instances/a/profile.json",
            InstanceProfileCodec.Serialize(Profile()));
        fileSystem.Directories.TryAdd("/instances/a/logs", 0);
        var processes = new FakeProcessInspector(process);
        var clock = new FakeClock { UtcNow = CreatedAt.AddMinutes(1) };
        var policy = new InstanceProfileRetentionPolicy(
            fileSystem,
            processes,
            clock,
            new IncrementingTemporaryPaths());
        return new PolicyFixture(fileSystem, processes, clock, policy);
    }

    private sealed record PolicyFixture(
        FakeFileSystem FileSystem,
        FakeProcessInspector Processes,
        FakeClock Clock,
        InstanceProfileRetentionPolicy Policy);

    private sealed class FakeClock : IInstanceProfileClock
    {
        public DateTimeOffset UtcNow { get; set; }
    }

    private sealed class FakeProcessInspector : IProcessIdentityInspector
    {
        private readonly ProcessIdentityObservation _observation;

        public FakeProcessInspector(ProcessIdentityObservation observation)
        {
            _observation = observation;
        }

        public int CallCount { get; private set; }
        public int LastProcessId { get; private set; }

        public ProcessIdentityObservation Inspect(int processId)
        {
            CallCount++;
            LastProcessId = processId;
            return _observation;
        }
    }

    private sealed class MappedProcessInspector : IProcessIdentityInspector
    {
        private readonly IReadOnlyDictionary<int, ProcessIdentityObservation> _observations;

        public MappedProcessInspector(
            IReadOnlyDictionary<int, ProcessIdentityObservation> observations)
        {
            _observations = observations;
        }

        public ProcessIdentityObservation Inspect(int processId) =>
            _observations[processId];
    }

    private sealed class IncrementingTemporaryPaths : IAtomicWritePathProvider
    {
        private int _next;

        public string CreateTemporarySiblingPath(string destinationPath) =>
            $"{destinationPath}.{Interlocked.Increment(ref _next)}.tmp";
    }

    private sealed class FakeFileSystem : IInstanceProfileFileSystem
    {
        private readonly object _sync = new();

        public ConcurrentDictionary<string, string> Files { get; } = new(StringComparer.Ordinal);
        public ConcurrentDictionary<string, byte> Directories { get; } = new(StringComparer.Ordinal);
        public List<string> ReplacedDestinations { get; } = [];
        public List<string> DeletedDirectories { get; } = [];
        public string? FailMoveDestination { get; set; }
        public string? FailReadPath { get; set; }

        public bool FileExists(string path) => Files.ContainsKey(path);
        public bool DirectoryExists(string path) => Directories.ContainsKey(path);
        public IEnumerable<string> EnumerateFiles(string path, string searchPattern) =>
            Files.Keys.Where(candidate =>
                string.Equals(Path.GetDirectoryName(candidate), path, StringComparison.Ordinal)
                && Path.GetFileName(candidate).EndsWith(".json", StringComparison.Ordinal));

        public string ReadAllText(string path)
        {
            if (string.Equals(path, FailReadPath, StringComparison.Ordinal))
            {
                throw new IOException("read failed");
            }

            return Files[path];
        }

        public void CreateDirectory(string path) => Directories.TryAdd(path, 0);
        public void WriteAllText(string path, string contents) => Files[path] = contents;

        public void MoveReplace(string sourcePath, string destinationPath)
        {
            lock (_sync)
            {
                if (string.Equals(destinationPath, FailMoveDestination, StringComparison.Ordinal))
                {
                    throw new IOException("move failed");
                }

                Files[destinationPath] = Files[sourcePath];
                Files.TryRemove(sourcePath, out _);
                ReplacedDestinations.Add(destinationPath);
            }
        }

        public void DeleteFile(string path) => Files.TryRemove(path, out _);

        public void DeleteDirectory(string path, bool recursive)
        {
            Directories.TryRemove(path, out _);
            DeletedDirectories.Add(path);
        }
    }
}
