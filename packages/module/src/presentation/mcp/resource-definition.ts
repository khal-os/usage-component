/**
 * Reference documents a client can read once and keep: the exact HTTP
 * contract these tools mirror, the months that exist, and the price table.
 * Not a second door to the data — the tools are the door; these exist so a
 * client can ground itself without guessing.
 */
export interface ResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
  read(): Promise<string>;
}
