using System.Text.Json;
using SampleApp.Domain;

namespace SampleApp;

public static class OrderLoader
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    public static Order Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", "order.json");
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<Order>(json, Options)
            ?? throw new InvalidOperationException($"Order at {path} is empty.");
    }
}
