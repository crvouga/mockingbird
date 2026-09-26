import type { Scenario } from "../harness/scenario.js"

const form = "application/x-www-form-urlencoded"
const SUPER_EMAIL = "admin@example.com"
const SUPER_PASSWORD = "medplum_admin"
const SUPER_CLIENT = "6f3f0c17-8bd1-4a56-9d5a-6b21e5b0a101"
const SUPER_SECRET = "mockingbird-local-secret"

export const authScenarios: Scenario[] = [
  {
    name: "auth: discovery documents and GET logout",
    steps: [
      { method: "GET", path: "/.well-known/openid-configuration", auth: "none" },
      { method: "GET", path: "/.well-known/smart-configuration", auth: "none" },
      { method: "GET", path: "/fhir/R4/.well-known/smart-configuration", auth: "none" },
      { method: "GET", path: "/oauth2/logout" },
      {
        name: "GET logout revokes the project client token",
        method: "GET",
        path: "/fhir/R4/Patient?_count=1",
      },
    ],
  },
  {
    name: "auth: unauthenticated and malformed credentials",
    steps: [
      { method: "GET", path: "/fhir/R4/Patient", auth: "none" },
      {
        method: "GET",
        path: "/fhir/R4/Patient",
        auth: "none",
        headers: { authorization: "Bearer not-a-jwt" },
      },
      {
        method: "GET",
        path: "/fhir/R4/Patient",
        auth: "none",
        headers: {
          authorization: "Bearer eyJhbGciOiJFUzM4NCIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.c2ln",
        },
      },
      {
        method: "GET",
        path: "/fhir/R4/Patient",
        auth: "none",
        headers: { authorization: `Basic ${btoa("nope:nope")}` },
      },
      {
        method: "GET",
        path: "/fhir/R4/Patient",
        auth: "none",
        headers: { authorization: "Digest abc" },
      },
      { method: "GET", path: "/fhir/R4/Patient?_medplum-prompt-basic-auth=1", auth: "none" },
      { method: "GET", path: "/auth/me", auth: "none" },
      { method: "GET", path: "/oauth2/userinfo", auth: "none" },
      { method: "GET", path: "/admin/projects/00000000-0000-4000-8000-000000000000", auth: "none" },
      { method: "GET", path: "/fhir/R4/metadata", auth: "none" },
      { method: "GET", path: "/fhir/R4/$versions", auth: "none" },
    ],
  },
  {
    name: "auth: Basic client credentials on FHIR requests",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        auth: "basic",
        body: { resourceType: "Patient", name: [{ family: "Basic" }] },
      },
      { method: "GET", path: "/fhir/R4/Patient?name=basic", auth: "basic" },
      { method: "GET", path: "/auth/me", auth: "basic" },
    ],
  },
  {
    name: "auth: token endpoint errors",
    steps: [
      { method: "POST", path: "/oauth2/token", auth: "none", raw: "", contentType: form },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=password",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        body: { grant_type: "client_credentials" },
        contentType: "application/json",
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=client_credentials",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: (v) => `grant_type=client_credentials&client_id=${v.clientId}`,
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: (v) => `grant_type=client_credentials&client_id=${v.clientId}&client_secret=wrong`,
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=client_credentials&client_id=00000000-0000-4000-8000-000000000000&client_secret=x",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        headers: { authorization: "Bearer abc" },
        raw: "grant_type=client_credentials",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        headers: (v) => ({ authorization: `Basic ${btoa(`${v.clientId}:wrong`)}` }),
        raw: "grant_type=client_credentials",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=authorization_code",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=authorization_code&code=0123456789abcdef0123456789abcdef",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=refresh_token",
        contentType: form,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: "grant_type=refresh_token&refresh_token=abc",
        contentType: form,
      },
    ],
  },
  {
    name: "auth: client credentials token and userinfo",
    steps: [
      {
        name: "client_credentials via form body",
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        raw: (v) =>
          `grant_type=client_credentials&client_id=${v.clientId}&client_secret=${v.clientSecret}`,
        contentType: form,
        compare: false,
      },
      { method: "GET", path: "/oauth2/userinfo" },
      { method: "POST", path: "/oauth2/userinfo" },
      { method: "GET", path: "/auth/me" },
    ],
  },
  {
    name: "auth: password login, code exchange with PKCE, refresh and logout",
    steps: [
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: {
          email: SUPER_EMAIL,
          password: SUPER_PASSWORD,
          clientId: SUPER_CLIENT,
          scope: "openid offline",
          codeChallenge: "plain-challenge-value",
          codeChallengeMethod: "plain",
        },
        save: { code: (b) => b?.code, login: (b) => b?.login },
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) =>
          `grant_type=authorization_code&code=${v.code}&client_id=${SUPER_CLIENT}&code_verifier=wrong`,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) => `grant_type=authorization_code&code=${v.code}&client_id=${SUPER_CLIENT}`,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) =>
          `grant_type=authorization_code&code=${v.code}&client_id=${SUPER_CLIENT}&code_verifier=plain-challenge-value`,
        save: { refresh: (b) => b?.refresh_token, access: (b) => b?.access_token },
      },
      {
        name: "a code is single use",
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) =>
          `grant_type=authorization_code&code=${v.code}&client_id=${SUPER_CLIENT}&code_verifier=plain-challenge-value`,
      },
      {
        method: "GET",
        path: "/auth/me",
        auth: "none",
        headers: (v) => ({ authorization: `Bearer ${v.access}` }),
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) => `grant_type=refresh_token&refresh_token=${v.refresh}`,
        save: { access2: (b) => b?.access_token },
      },
      {
        name: "a rotated refresh token no longer works",
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) => `grant_type=refresh_token&refresh_token=${v.refresh}`,
      },
      {
        method: "POST",
        path: "/oauth2/logout",
        auth: "none",
        headers: (v) => ({ authorization: `Bearer ${v.access2}` }),
      },
      {
        method: "GET",
        path: "/fhir/R4/Patient?_count=1",
        auth: "none",
        headers: (v) => ({ authorization: `Bearer ${v.access2}` }),
      },
    ],
  },
  {
    name: "auth: login validation and failures",
    steps: [
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: {},
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: { email: "not-an-email", password: "short" },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: { email: "nobody@example.com", password: "password123" },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: { email: SUPER_EMAIL, password: "wrong-password" },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: { email: SUPER_EMAIL, password: SUPER_PASSWORD, codeChallengeMethod: "plain" },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: {
          email: SUPER_EMAIL,
          password: SUPER_PASSWORD,
          codeChallenge: "x",
          codeChallengeMethod: "S512",
        },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: {
          email: SUPER_EMAIL,
          password: SUPER_PASSWORD,
          clientId: "00000000-0000-4000-8000-000000000000",
        },
      },
      {
        method: "POST",
        path: "/auth/login",
        auth: "none",
        contentType: "application/json",
        body: {
          email: SUPER_EMAIL,
          password: SUPER_PASSWORD,
          codeChallenge: "abc",
          codeChallengeMethod: "S256",
        },
        save: { code: (b) => b?.code },
      },
      {
        name: "S256 verifier",
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (v) => `grant_type=authorization_code&code=${v.code}&code_verifier=abc`,
      },
      {
        method: "POST",
        path: "/oauth2/token",
        auth: "none",
        contentType: form,
        raw: (_v) =>
          `grant_type=client_credentials&client_id=${SUPER_CLIENT}&client_secret=${SUPER_SECRET}&scope=openid%20profile`,
        compare: false,
      },
    ],
  },
]
