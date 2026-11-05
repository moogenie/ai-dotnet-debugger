namespace SampleApp.Domain;

public static class Refunds
{
    public static IReadOnlyList<string> Describe(Order order)
    {
        var messages = new List<string>();
        foreach (var line in order.CancelledLines)
        {
            var product = order.FindProduct(line.ProductNumber);
            var supplier = product.Supplier.ToUpperInvariant();
            messages.Add($"Refund {Money.Format(line.Amount)} on {product.Name} ({supplier}), discontinued product");
        }

        return messages;
    }
}
