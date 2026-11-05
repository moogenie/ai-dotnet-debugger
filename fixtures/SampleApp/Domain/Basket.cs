namespace SampleApp.Domain;

public sealed class Basket(IReadOnlyList<OrderLine> lines)
{
    public const int DiscountPercent = 18;

    private int _summaryReads;

    public decimal Gross => lines.Sum(line => line.Amount);

    public int SummaryReads => _summaryReads;

    public string Summary
    {
        get
        {
            _summaryReads++;
            return $"Basket: {lines.Count} lines, gross {Money.Format(Gross)}";
        }
    }

    public LineTotal Calculate(int productNumber)
    {
        var net = Gross * (1 - DiscountPercent / 100);
        var productAmount = lines.Where(line => line.ProductNumber == productNumber).Sum(line => line.Amount);
        return new LineTotal(productNumber, Math.Round(net / Gross * productAmount, 2));
    }
}
