namespace SampleApp.Domain;

// Synthetic values only. They exist so the extension's redaction can be tested against a real debugger.
public sealed record TestCredentials
{
    public required string ApiToken { get; init; }

    public required string CardNumber { get; init; }

    public required string ConnectionString { get; init; }

    public required string ContactEmail { get; init; }

    public required string Label { get; init; }

    public required string SessionJwt { get; init; }

    public static TestCredentials CreateSynthetic() => new()
    {
        ApiToken = "tok_test_9f8e7d6c5b4a39281706",
        CardNumber = "4111 1111 1111 1111",
        ConnectionString = "Server=localhost;Database=SampleTest;User ID=sample_user;Password=NotARealPassword1;",
        ContactEmail = "synthetic.user@example.com",
        Label = "synthetic test credentials",
        SessionJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiU3ludGhldGljIFRlc3QgVXNlciIsInN1YiI6InRlc3QtdXNlci0wMDAxIn0.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA",
    };
}
