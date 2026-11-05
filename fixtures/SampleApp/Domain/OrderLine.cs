namespace SampleApp.Domain;

public sealed record OrderLine
{
    public required int ProductNumber { get; init; }

    public required decimal Amount { get; init; }
}
