using SampleApp;
using SampleApp.Domain;

// Usage: dotnet run -- [discount|instalments|refund|all|secrets|wait]   (default: all; secrets and wait are not in all)
var scenario = args.Length > 0 ? args[0].ToLowerInvariant() : "all";
var order = OrderLoader.Load();
Console.WriteLine($"{order.Name} [{order.OrderId}], scenario: {scenario}");

if (scenario is "discount" or "all")
{
    var basket = new Basket(order.Lines);
    var total = basket.Calculate(order.Lines[0].ProductNumber);
    Console.WriteLine(basket.Summary);
    Console.WriteLine($"Discounted amount for #{total.ProductNumber}: {Money.Format(total.Amount)}");
    Console.WriteLine($"Summary reads: {basket.SummaryReads}");
}

if (scenario is "instalments" or "all")
{
    var plan = new InstalmentPlan(order.Lines);
    foreach (var instalment in plan.Calculate())
    {
        Console.WriteLine(
            $"Instalment {instalment.Number} of {InstalmentPlan.InstalmentCount}: {Money.Format(instalment.Amount)}");
    }
}

if (scenario is "refund" or "all")
{
    foreach (var line in Refunds.Describe(order))
    {
        Console.WriteLine(line);
    }
}

if (scenario is "secrets")
{
    var credentials = TestCredentials.CreateSynthetic();
    Console.WriteLine($"Loaded {credentials.Label}");
}

if (scenario is "wait")
{
    const int MaxWaitSeconds = 120;
    Console.WriteLine($"Waiting up to {MaxWaitSeconds} s for a debugger to attach.");
    for (var second = 0; second < MaxWaitSeconds; second++)
    {
        Thread.Sleep(TimeSpan.FromSeconds(1));
    }
}
