import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@/components/home/hero-banner-controls-lazy', () => ({ HeroBannerControls: () => null }))
import { HeroBanner } from './preview-hero'
import type { PublicHomeBanner } from '@dpg/app-contracts'
const banners: PublicHomeBanner[] = [1, 2, 3].map(id => ({ id, title: `Banner ${id}`, imageUrl: `https://public.example/banner-${id}.png`,
  mobileImageUrl: `https://public.example/banner-${id}.png`, desktopImageUrl: `https://public.example/banner-${id}.png`, desktopLargeImageUrl: `https://public.example/banner-${id}.png`, linkUrl: null }))
afterEach(() => vi.unstubAllEnvs())
it('renders the verified artwork in fixed staging using the canonical Production Hero', () => {
  vi.stubEnv('APP_ENV', 'production')
  const production = renderToStaticMarkup(<HeroBanner banners={banners} />)
  vi.stubEnv('APP_ENV', 'staging')
  expect(renderToStaticMarkup(<HeroBanner banners={banners} />)).toBe(production)
  expect(production).toContain('1 trên 3')
  expect(production).not.toContain('editorial.w960.webp')
})
it('does not enable the fallback artwork on an empty or local fixture preview', () => {
  vi.stubEnv('APP_ENV', 'staging')
  expect(renderToStaticMarkup(<HeroBanner banners={[]} />)).toBe('')
  vi.stubEnv('APP_ENV', 'preview')
  expect(renderToStaticMarkup(<HeroBanner banners={banners} />)).toBe('')
})
