export class ChannelValidationError extends Error {
  public readonly code = "ChannelValidationError";
  public override readonly name = "ChannelValidationError";

  constructor(message: string) {
    super(message);
  }
}
