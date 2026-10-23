// The little of Deno the WhatsApp bot uses, so tsc can check it without Deno
// installed (npm run check:bot). Deploying still uses Deno itself.
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
