namespace SampleApp.Domain;

public sealed record Order
{
    public required string OrderId { get; init; }

    public required string Name { get; init; }

    public required IReadOnlyList<Product> Products { get; init; }

    public required IReadOnlyList<OrderLine> Lines { get; init; }

    public required IReadOnlyList<OrderLine> CancelledLines { get; init; }

    public Product FindProduct(int number) => Products.Single(p => p.Number == number);
}
