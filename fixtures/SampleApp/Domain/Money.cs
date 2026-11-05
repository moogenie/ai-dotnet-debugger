using System.Globalization;

namespace SampleApp.Domain;

public static class Money
{
    // Fixed format so output is identical on macOS and Windows, whatever the OS culture.
    public static string Format(decimal amount) => "GBP " + amount.ToString("F2", CultureInfo.InvariantCulture);
}
