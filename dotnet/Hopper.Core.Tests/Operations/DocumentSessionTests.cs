using System.Text.Json;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Xunit;

namespace Hopper.Core.Tests.Operations;

public sealed class DocumentSessionTests
{
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
