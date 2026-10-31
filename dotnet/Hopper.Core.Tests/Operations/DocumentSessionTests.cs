using System.Text.Json;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Xunit;

namespace Hopper.Core.Tests.Operations;

public sealed class DocumentSessionTests
{

    [Theory]
    [InlineData("active", true)]
    [InlineData("active", false)]
    [InlineData("idle", true)]
    public void DocumentChangeAbandonsAnActiveNativeOrTrackedTransaction(string state, bool nativeActive)
    {
        var owner = "test-" + Guid.NewGuid();
        var before = DocumentSession.Advance(owner, "document-a", state);
        var closed = false;
        DocumentSession.AbandonActiveSegment(owner, nativeActive, () => closed = true);
        var after = DocumentSession.Segment(owner);
        Assert.True(closed);
        Assert.Equal("abandoned", after.State);
        Assert.Null(after.DocumentId);
        Assert.Null(after.SegmentId);
        Assert.Equal(before.Epoch + 1, after.Epoch);
        var stale = JsonSerializer.SerializeToElement(new { expectedSegment = before }, RpcV2Contract.JsonOptions);
        Assert.Throws<DocumentOperationException>(() => DocumentSession.ValidateSegment(owner, stale));
    }

    [Fact]
    public void FailedNativeCleanupStillRequiresRecovery()
    {
        var owner = "test-" + Guid.NewGuid();
        DocumentSession.Advance(owner, "document-a", "active");
        Assert.Throws<InvalidOperationException>(() => DocumentSession.AbandonActiveSegment(owner, true,
            () => throw new InvalidOperationException("Document already closed")));
        Assert.Equal("abandoned", DocumentSession.Segment(owner).State);
    }

    [Fact] public void OldSegmentCannotCancelNewDocument()
    {
        var owner = "test-" + Guid.NewGuid();
        var first = DocumentSession.Advance(owner, "document-a", "active");
        DocumentSession.Advance(owner, null, "idle");
        var current = DocumentSession.Advance(owner, "document-b", "active");
        var stale = JsonSerializer.SerializeToElement(new { expectedSegment = first }, RpcV2Contract.JsonOptions);
        var error = Assert.Throws<DocumentOperationException>(() => DocumentSession.ValidateSegment(owner, stale));
        Assert.Equal("TRANSACTION_CHANGED", error.Code);
        var fresh = JsonSerializer.SerializeToElement(new { expectedSegment = current }, RpcV2Contract.JsonOptions);
        DocumentSession.ValidateSegment(owner, fresh);
    }
    [Fact] public void SegmentFromDifferentLifecycleIsRejected()
    {
        var owner = "test-" + Guid.NewGuid();
        var segment = DocumentSession.Advance(owner, "document", "active");
        var stale = JsonSerializer.SerializeToElement(new { expectedSegment = segment with { LifecycleInstanceId = "retired-lifecycle" } }, RpcV2Contract.JsonOptions);
        Assert.Throws<DocumentOperationException>(() => DocumentSession.ValidateSegment(owner, stale));
    }
}
