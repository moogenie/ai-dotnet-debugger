namespace SampleApp.Domain;

public sealed class InstalmentPlan(IReadOnlyList<OrderLine> lines)
{
    public const int DiscountPercent = 18;

    public const int InstalmentCount = 3;

    public decimal Gross => lines.Sum(line => line.Amount);

    public IReadOnlyList<Instalment> Calculate()
    {
        var net = Gross * (100 - DiscountPercent) / 100m;
        var perInstalment = net / InstalmentCount;
        var schedule = new List<Instalment>();

        for (var number = 1; number < InstalmentCount; number++)
        {
            schedule.Add(new Instalment(number, Math.Round(perInstalment, 2)));
        }

        return schedule;
    }
}
