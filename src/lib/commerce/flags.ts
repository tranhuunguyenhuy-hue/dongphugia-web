// #470 commerce v1: the storefront shows the cart/quote UI only where the Worker will also accept intake (same rule as apps/public/src/runtime/commerce-intake.ts,
// minus the binding which only the Worker can see). Production: explicit PUBLIC_COMMERCE=on; TEST Preview: isolated staging + the flag. Everything else: OFF.
export type CommerceEnv = { APP_ENV?: string; PREVIEW_TEST_DATABASE_ISOLATED?: string; PUBLIC_COMMERCE?: string }
export function commerceEnabled(env: CommerceEnv = process.env as CommerceEnv): boolean {
    if (env.PUBLIC_COMMERCE !== 'on') return false
    return env.APP_ENV === 'production' || (env.APP_ENV === 'staging' && env.PREVIEW_TEST_DATABASE_ISOLATED === 'true')
}
