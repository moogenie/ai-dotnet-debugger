import { z } from "zod";

// The subset of the Debug Adapter Protocol this extension consumes.
// Messages come from a third-party adapter, so every shape is validated at this boundary.

export const sourceSchema = z.looseObject({
  name: z.string().optional(),
  path: z.string().optional(),
  presentationHint: z.string().optional(),
});

export const stoppedEventBodySchema = z.looseObject({
  allThreadsStopped: z.boolean().optional(),
  reason: z.string(),
  text: z.string().optional(),
  threadId: z.number().optional(),
});

export const continuedEventBodySchema = z.looseObject({
  allThreadsContinued: z.boolean().optional(),
  threadId: z.number(),
});

export const outputEventBodySchema = z.looseObject({
  category: z.string().optional(),
  output: z.string(),
});

export const exitedEventBodySchema = z.looseObject({
  exitCode: z.number(),
});

export const protocolMessageSchema = z.looseObject({
  body: z.unknown().optional(),
  command: z.string().optional(),
  event: z.string().optional(),
  success: z.boolean().optional(),
  type: z.string(),
});

export const stackFrameSchema = z.looseObject({
  column: z.number(),
  id: z.number(),
  line: z.number(),
  name: z.string(),
  presentationHint: z.string().optional(),
  source: sourceSchema.optional(),
});

export const stackTraceResponseSchema = z.looseObject({
  stackFrames: z.array(stackFrameSchema),
  totalFrames: z.number().optional(),
});

export const threadsResponseSchema = z.looseObject({
  threads: z.array(z.looseObject({ id: z.number(), name: z.string() })),
});

export const scopesResponseSchema = z.looseObject({
  scopes: z.array(z.looseObject({ name: z.string(), variablesReference: z.number() })),
});

export const variablePresentationHintSchema = z.looseObject({
  attributes: z.array(z.string()).optional(),
  kind: z.string().optional(),
  visibility: z.string().optional(),
});

export const variableSchema = z.looseObject({
  evaluateName: z.string().optional(),
  name: z.string(),
  presentationHint: variablePresentationHintSchema.optional(),
  type: z.string().optional(),
  value: z.string(),
  variablesReference: z.number(),
});

export const variablesResponseSchema = z.looseObject({
  variables: z.array(variableSchema),
});

export const evaluateResponseSchema = z.looseObject({
  presentationHint: variablePresentationHintSchema.optional(),
  result: z.string(),
  type: z.string().optional(),
  variablesReference: z.number(),
});

export const exceptionInfoResponseSchema = z.looseObject({
  breakMode: z.string(),
  description: z.string().optional(),
  details: z.looseObject({ stackTrace: z.string().optional() }).optional(),
  exceptionId: z.string(),
});

export type IStackFrame = z.infer<typeof stackFrameSchema>;
export type IDapVariable = z.infer<typeof variableSchema>;
