// An agent-blind session still runs normally for the person; no tool returns data from it.

export interface ISessionEligibility {
  isAgentVisible: boolean;
  reasons: string[];
}

const SUPPORTED_TYPE = "coreclr";
const ENVIRONMENT_VARIABLES = ["ASPNETCORE_ENVIRONMENT", "DOTNET_ENVIRONMENT"];

export function assessSession(configuration: Readonly<Record<string, unknown>>): ISessionEligibility {
  const reasons: string[] = [];
  if (configuration.type !== SUPPORTED_TYPE) {
    reasons.push(`its debug type '${String(configuration.type)}' is not supported`);
  }
  if (configuration.request !== "launch") {
    reasons.push(`it is a '${String(configuration.request)}' request, and only local launches are allowed`);
  }
  if (configuration.pipeTransport !== undefined) reasons.push("it uses pipeTransport, which can reach another machine");
  if (configuration.processId !== undefined) reasons.push("it targets an existing process by processId");
  const environment = configuration.env;
  if (environment && typeof environment === "object") {
    for (const variable of ENVIRONMENT_VARIABLES) {
      const value = (environment as Record<string, unknown>)[variable];
      if (typeof value === "string" && value.trim().toLowerCase() === "production") {
        reasons.push(`it sets ${variable} to Production`);
      }
    }
  }
  return { isAgentVisible: reasons.length === 0, reasons };
}
