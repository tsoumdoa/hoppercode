using System.Text.Json;
using Hopper.Core.Protocol;
using Xunit;

namespace Hopper.Core.Tests;

public class RpcProtocolV2Tests
{
    [Fact]
    public void SharedRequestFixturesMatchCSharpContract()
    {
        using var fixtures = ReadContractJson("fixtures.json");

        foreach (var fixture in fixtures.RootElement.GetProperty("validRequests").EnumerateArray())
        {
            var result = RpcV2Contract.ParseRequest(fixture.GetProperty("value").GetRawText());
            Assert.True(result.IsValid, Failure(fixture, result.Errors));
            Assert.NotNull(result.Value);
            Assert.True(RpcV2Contract.ParseRequest(RpcV2Contract.SerializeRequest(result.Value)).IsValid);
        }

        foreach (var fixture in fixtures.RootElement.GetProperty("invalidRequests").EnumerateArray())
        {
            var result = RpcV2Contract.ParseRequest(fixture.GetProperty("value").GetRawText());
            Assert.False(result.IsValid, fixture.GetProperty("name").GetString());
            Assert.Null(result.Value);
        }
    }

    [Fact]
    public void SharedResponseFixturesMatchCSharpContract()
    {
        using var fixtures = ReadContractJson("fixtures.json");

        foreach (var fixture in fixtures.RootElement.GetProperty("validResponses").EnumerateArray())
        {
            var result = RpcV2Contract.ParseResponse(fixture.GetProperty("value").GetRawText());
            Assert.True(result.IsValid, Failure(fixture, result.Errors));
            Assert.NotNull(result.Value);
            Assert.True(RpcV2Contract.ParseResponse(RpcV2Contract.SerializeResponse(result.Value)).IsValid);
        }

        foreach (var fixture in fixtures.RootElement.GetProperty("invalidResponses").EnumerateArray())
        {
            var result = RpcV2Contract.ParseResponse(fixture.GetProperty("value").GetRawText());
            Assert.False(result.IsValid, fixture.GetProperty("name").GetString());
            Assert.Null(result.Value);
        }
    }

    private static JsonDocument ReadContractJson(string fileName)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "protocol", "v2", fileName);
        Assert.True(File.Exists(path), $"Shared contract file was not copied to test output: {path}");
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    private static string Failure(JsonElement fixture, IReadOnlyList<string> errors) =>
        $"{fixture.GetProperty("name").GetString()}: {string.Join("; ", errors)}";

}
