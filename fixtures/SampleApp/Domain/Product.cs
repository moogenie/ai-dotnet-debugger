namespace SampleApp.Domain;

public sealed record Product
{
    public required int Number { get; init; }

    public required string Name { get; init; }

    public string Supplier { get; init; } = default!;

    public bool IsDiscontinued { get; init; }
}
