// ScaleFlow is currently single-tenant: Clerk gates who can sign in, but
// every sheet/row/cell in Supabase is scoped to this one fixed
// organization_id rather than to the signed-in user's real Clerk org. This
// constant centralizes that placeholder so it isn't duplicated (and doesn't
// drift) across every call site - swap it out once real per-org data
// scoping (e.g. via Clerk's auth().orgId) is wired up.
export const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID ?? "rc_org_1";
