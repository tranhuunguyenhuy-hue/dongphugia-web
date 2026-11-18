import NextLink from 'next/link'
import type { ComponentProps } from 'react'

// The back office is low-traffic, but on the Cloudflare Free plan every viewport prefetch is a full Worker
// invocation (RSC render + Prisma) that spends the CPU allowance. Measured on the M3 Preview: 69 of 99 Worker
// requests during a 3-iteration browser session were Link prefetches and the isolate then answered 503
// (exceededResources, killed at 10 ms CPU). Prefetching buys nothing here, so Admin links opt out by default;
// pass prefetch explicitly to override.
export default function AdminLink({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />
}
