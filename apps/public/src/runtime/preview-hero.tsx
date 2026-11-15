import { HeroBanner as CanonicalHeroBanner } from '../../../../src/components/home/hero-banner'
import type { PublicHomeBanner } from '@dpg/app-contracts'

// The legacy fallback bitmap contains stale prices. Production supplies the
// verified artwork. Fixed staging receives the same verified banner props.
export function HeroBanner(props:{banners:readonly PublicHomeBanner[]}) {
  return (process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging') && props.banners.length > 0
    ? <CanonicalHeroBanner {...props} /> : null
}
