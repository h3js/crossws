// You can run this demo using `npm run play:sse` in repo

import sseAdapter from "../../src/adapters/sse.ts";
import { createDemo, getIndexHTML, handleDemoRoutes } from "./_shared.ts";

const ws = createDemo(sseAdapter, { bidir: true });

const port = Number.parseInt(Deno.env.get("PORT") || "") || 3001;

const handler = async (request: Request) => {
  const response = handleDemoRoutes(ws, request);
  if (response) {
    return response;
  }

  // Handle SSE
  if (
    request.headers.get("accept") === "text/event-stream" ||
    request.headers.has("x-crossws-id")
  ) {
    return ws.fetch(request);
  }

  return new Response(await getIndexHTML({ sse: true }), {
    headers: { "Content-Type": "text/html" },
  });
};

// Start HTTP server
Deno.serve({ hostname: "localhost", port }, handler);

// Start TLS server (skipped in test runs to avoid port collisions)
if (!Deno.env.get("PORT")) {
  Deno.serve({ hostname: "localhost", port: port + 1, ...getCert() }, handler);
}

function getCert() {
  return {
    cert: `-----BEGIN CERTIFICATE-----
MIIEZzCCAs+gAwIBAgIQVyX6P9rDCswFmeOSj8BmPTANBgkqhkiG9w0BAQsFADCB
izEeMBwGA1UEChMVbWtjZXJ0IGRldmVsb3BtZW50IENBMTAwLgYDVQQLDCdwb295
YUBQb295YXMtTGFwdG9wLmxvY2FsIChQb295YSBQYXJzYSkxNzA1BgNVBAMMLm1r
Y2VydCBwb295YUBQb295YXMtTGFwdG9wLmxvY2FsIChQb295YSBQYXJzYSkwHhcN
MjQwODA3MTM1NjU2WhcNMjYxMTA3MTQ1NjU2WjBbMScwJQYDVQQKEx5ta2NlcnQg
ZGV2ZWxvcG1lbnQgY2VydGlmaWNhdGUxMDAuBgNVBAsMJ3Bvb3lhQFBvb3lhcy1M
YXB0b3AubG9jYWwgKFBvb3lhIFBhcnNhKTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMJmEyDqC8/JqJK95+rmVL+eHxcg0B7btm4j6T4Xw2ls0Wop+YOn
eJIPvSsmgo6JIWeTQ4c5oNt+KBSR8uJhkxg07qgZsgpmz4nRVk0/ctwF/eDlw0TE
0hAm/ZM7tossm2WbWJMJM9pVc3g8DYm8Y8N3aE7E12Kcc59oMMc7mpUkifUlsGT1
lcvBevdbGcsBsN3sZnj1mCpG2x6GbhbY7knkv5uqwUb3PtGXUVQztZacxcKjUiCg
GausF0VJ2xnVp0kI62CZStF1vJFNL9KsIn89/ZwtoQErfqqHoWz/Xx3xVHft6FDB
T9y9XBRd2oI4GUAZwKmHltycWaXzY0ewnl0CAwEAAaN2MHQwDgYDVR0PAQH/BAQD
AgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB8GA1UdIwQYMBaAFClgBKwJPM5UroN+
mpjlJakNc+mPMCwGA1UdEQQlMCOCCWxvY2FsaG9zdIcQAAAAAAAAAAAAAAAAAAAA
AYcEfwAAATANBgkqhkiG9w0BAQsFAAOCAYEAET312O3GMspkjF/P0SlXdpMFzZXk
CgxQ5LIvXfaNnheXNYUrdl/XMbZwB1ejp0TmMgv2mOucPyTq7gLsPDEULXelzNQg
GStbST/4bh7TVyfh1oLUkPFz2cKMEkzt2xdHNgqAcUn8ioYVAkU2Hf+1mppdh125
bZOr5Ya3FDowhWU7FOiZlC2WVvNJ+rPcZS4xAWeT9XeCgSuYqGcG63f0cGAP7Ann
XR/Z1KVaa6Zh4PUynZmuBwoIVjzTUzRdfwrDmxr7SpadcTvug2qnmJe7SHPlH9QP
6Fk4Y1quGUbTpb4KmcZcq4fLP4tZOULzB9CBiiTlwBJwg1D661XZj4jjuJ+8qYCj
oyM4gguV/P9rqzdMgBOtzeheP7so//x5//oPA5NwXB+2tPLPIihffVAiPI6yULE4
baiAvBhaCAxCuAhAFlILCiJXDbuH4FW8cisH/e7sTLiW9AVlmjcjeIHvWaupobI0
6ucGp7VL+LZTK2FkIXShtkL5/tzm6jLNpuPp
-----END CERTIFICATE-----
`,
    key: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDCZhMg6gvPyaiS
vefq5lS/nh8XINAe27ZuI+k+F8NpbNFqKfmDp3iSD70rJoKOiSFnk0OHOaDbfigU
kfLiYZMYNO6oGbIKZs+J0VZNP3LcBf3g5cNExNIQJv2TO7aLLJtlm1iTCTPaVXN4
PA2JvGPDd2hOxNdinHOfaDDHO5qVJIn1JbBk9ZXLwXr3WxnLAbDd7GZ49ZgqRtse
hm4W2O5J5L+bqsFG9z7Rl1FUM7WWnMXCo1IgoBmrrBdFSdsZ1adJCOtgmUrRdbyR
TS/SrCJ/Pf2cLaEBK36qh6Fs/18d8VR37ehQwU/cvVwUXdqCOBlAGcCph5bcnFml
82NHsJ5dAgMBAAECggEANZ4p0H49W8ZnNHIksWluHpviP2LRhHFdU+ubvYCYaU+W
Qw3owCNE4iRtLKWmhOHV0NeRXI7Miz20mFfZAg+fnqGa4cqUjMHmpECU6SGC8KTG
bW1x+lm/Bq16a02g/6oCAnhiacuz/ZhsDNGjekX3zkX1AyTPs2crjOAT9B/Adznt
Xf3pGRp8FgBFSTEbFEW+Pqy0Z345LTAZ6UpvXJl3BPb5bJovcyyZg/Mpoe2tQMex
o/uuYE52u3aY1sX7dq0qGVT0aDGrSFVjcdra3tb+nmlF43FPfC3EQtmoyhmiUXmn
lodSZ2IijVWI532nvsXRVJaFN5WWHJykEc05cTAKkQKBgQDwJvM2a/xvH/+MWpTx
6gPW9MoN+UcALMvY43NYubYmSyzYnzbPjDaN+djrN/eR6WLhycn8MPMcc33ydu1L
p7UEOWdfWrhzZXnA8CXsKSs/KpNdfjfyjCYD5dGEUwMuzUW6pB8+fOoi4rdBDaSC
KZ9UjgedNJz0e23u81uK9sJJ/wKBgQDPOi6GHAuaHbtQbPwGmyGBP3uyAKLblOMW
Q9mwJPv7SQO475lVEuYgYNOQPgIHQqeWMlRm7mrkfi4yNnGaMy5HT1GW8KlyDBEd
zMw3zF+OrRklEFGGnH0PlBQoQ9CegutClZCP5nh8k7aYJqNgNt44K5Yp1AxfnXlp
Ta6D/Lp/owKBgGwcLLsgK9je380QbiLlhWr8cgWOZa8ne3EdG60ilWRxzTOLoUIX
zetmQYfKfzH5jeE1VS+p3Ze+SkGf1j2Ltwq6yNV9YrHYSdJYicnh0q0x/ntFOex/
uRFiIUrfj/w+vphCECqyUzj3NSYc/ST3ldmbwsO7jrjk492BQoGxik+DAoGAXY6S
+pEm28mYi9LoZcMb+VJD8jU/UYuCisbPPSs1aFmqiJAD1djWdL/CRFj6aXS6XKEU
YfQ55jbhfGIAH/IDbsZsu4yjs42nHKEdggOPEMctlwIrDG8SNzpPb25OfYH13PXR
cmZG91dpFIA9Om8LHKjw/qlxfKmH6vbbV1N+j6kCgYBW5bWZJ/VTlWTF6safPEkz
/NaBIetAk5WDsLt9fz/+ZXWw4AoomMFv2rA4zHDde9tS7NsQMeTNTZHlwazY6/Ek
hksf1vkN0QSwyL+eQoFbjB+ZkHqizXNyIbV/4i+JU9gnSyVVWzlVRmlk98RjBQCe
NxWZH4tpKI9i42Uv2aNVPg==
-----END PRIVATE KEY-----`,
  };
}
