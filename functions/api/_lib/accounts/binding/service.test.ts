import { onRequestPost as challengeRoute } from "../../../account/challenge";
import { onRequestPost as bindRoute } from "../../../account/bind";
import {
  decodeAccountBindingChallenge,
  encodeAccountBindingChallenge,
  serializeAccountBindingChallenge,
} from "../../../../../shared/auth/codecs/account-binding-v1";
import {
  accessCookieName,
  bindHarnessAccount,
  createHarness,
  origin,
  requestContext,
  toBase64Url,
} from "../testing/key-exchange-fixture";

describe("account binding Pages contracts", () => {
  it("rejects cross-origin challenge creation before persisting anything", async () => {
    const harness = await createHarness();
    const response = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, {
          method: "POST",
          headers: { ...harness.headers, Origin: "https://evil.test" },
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(403);
    expect(harness.database.challenges.size).toBe(0);
  });

  it("binds only a valid pinned-key challenge and does not mutate on replay", async () => {
    const harness = await createHarness();
    const { challenge, bindResponse } = await bindHarnessAccount(harness);
    expect(bindResponse.status).toBe(201);
    expect(harness.database.bindings.get(harness.accountId)?.user_id).toBe(
      "user_01",
    );

    const replaySignature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      harness.signingPair.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
    );
    const replay = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: encodeAccountBindingChallenge(challenge),
            signature: toBase64Url(new Uint8Array(replaySignature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(replay.status).toBe(200);
    expect(harness.database.bindings.size).toBe(1);
  });

  it("rejects a wrong signing key without consuming or binding the challenge", async () => {
    const harness = await createHarness();
    const challengeResponse = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, {
          method: "POST",
          headers: harness.headers,
        }),
        harness.env,
      ),
    );
    const challengeBody = (await challengeResponse.json()) as {
      challenge: unknown;
    };
    const challenge = decodeAccountBindingChallenge(challengeBody.challenge);
    if (!challenge) throw new Error("Expected a V1 account-binding challenge.");
    const other = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      other.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
    );
    const response = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: encodeAccountBindingChallenge(challenge),
            signature: toBase64Url(new Uint8Array(signature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(401);
    expect(harness.database.bindings.size).toBe(0);
    expect(
      harness.database.challenges.get(challenge.challengeId)?.consumed_at,
    ).toBeNull();
  });

  it("rejects an expired challenge without creating a binding", async () => {
    const harness = await createHarness();
    const challengeResponse = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, {
          method: "POST",
          headers: harness.headers,
        }),
        harness.env,
      ),
    );
    const challenge = decodeAccountBindingChallenge(
      ((await challengeResponse.json()) as { challenge: unknown }).challenge,
    );
    if (!challenge) throw new Error("Expected a V1 account-binding challenge.");
    const stored = harness.database.challenges.get(challenge.challengeId);
    if (!stored) throw new Error("Expected persisted challenge.");
    stored.expires_at = Date.now() - 1;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      harness.signingPair.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
    );
    const response = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: encodeAccountBindingChallenge(challenge),
            signature: toBase64Url(new Uint8Array(signature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(409);
    expect(harness.database.bindings.size).toBe(0);
  });

  it("allows only one OpenAuth user to win competing valid account claims", async () => {
    const harness = await createHarness();
    harness.database.users.add("user_02");
    const secondAccess = await harness.authority.token("user_02");
    const secondHeaders = {
      ...harness.headers,
      Cookie: `${accessCookieName}=${secondAccess}`,
    };
    const [firstChallengeResponse, secondChallengeResponse] = await Promise.all(
      [
        challengeRoute(
          requestContext(
            new Request(`${origin}/api/account/challenge`, {
              method: "POST",
              headers: harness.headers,
            }),
            harness.env,
          ),
        ),
        challengeRoute(
          requestContext(
            new Request(`${origin}/api/account/challenge`, {
              method: "POST",
              headers: secondHeaders,
            }),
            harness.env,
          ),
        ),
      ],
    );
    const firstChallenge = decodeAccountBindingChallenge(
      ((await firstChallengeResponse.json()) as { challenge: unknown })
        .challenge,
    );
    const secondChallenge = decodeAccountBindingChallenge(
      ((await secondChallengeResponse.json()) as { challenge: unknown })
        .challenge,
    );
    if (!firstChallenge || !secondChallenge) {
      throw new Error("Expected V1 account-binding challenges.");
    }
    const sign = async (challenge: typeof firstChallenge) =>
      toBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            harness.signingPair.privateKey,
            new TextEncoder().encode(
              serializeAccountBindingChallenge(challenge),
            ),
          ),
        ),
      );
    const [first, second] = await Promise.all([
      bindRoute(
        requestContext(
          new Request(`${origin}/api/account/bind`, {
            method: "POST",
            headers: { ...harness.headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              challenge: encodeAccountBindingChallenge(firstChallenge),
              signature: await sign(firstChallenge),
            }),
          }),
          harness.env,
        ),
      ),
      bindRoute(
        requestContext(
          new Request(`${origin}/api/account/bind`, {
            method: "POST",
            headers: { ...secondHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              challenge: encodeAccountBindingChallenge(secondChallenge),
              signature: await sign(secondChallenge),
            }),
          }),
          harness.env,
        ),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(harness.database.bindings.size).toBe(1);
  });
});
