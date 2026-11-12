/** Test stand-in for the "cloudflare:workers" module: just enough DurableObject for unit tests. */
export class DurableObject<E = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: E,
  ) {}
}
