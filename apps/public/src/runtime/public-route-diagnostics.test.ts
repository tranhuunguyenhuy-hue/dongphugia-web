import { describe, expect, it } from 'vitest'
import { isExpectedPublicNotFound, publicRouteFailureSummary } from './public-route-diagnostics'

describe('safe Public route failure summary', () => {
  it('keeps only error class, allowlisted application code, and SQLSTATE', () => {
    const error = Object.assign(new TypeError('PUBLIC_PRODUCT_DB_ROW_INVALID customer@example.test'), { code: '42501' })
    const summary = publicRouteFailureSummary(error)

    expect(summary).toEqual({
      errorClass: 'TypeError', publicErrorCode: 'PUBLIC_PRODUCT_DB_ROW_INVALID', sqlState: '42501',
    })
    expect(JSON.stringify(summary)).not.toContain('customer@example.test')
  })

  it('never emits arbitrary database or rendering exception text', () => {
    const summary = publicRouteFailureSummary(new Error('permission denied for customers: private details'))
    expect(summary).toEqual({ errorClass: 'Error' })
  })

  it('labels bounded PostgreSQL capacity failures without exposing query details', () => {
    const summary = publicRouteFailureSummary(new Error('PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED'))
    expect(summary).toEqual({ errorClass: 'Error', publicErrorCode: 'PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED' })
  })

  it('distinguishes intentional Next 404 routing from an application render failure', () => {
    expect(isExpectedPublicNotFound(Object.assign(new Error('Not Found'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }))).toBe(true)
    expect(isExpectedPublicNotFound(new Error('Query read timeout'))).toBe(false)
  })
})
