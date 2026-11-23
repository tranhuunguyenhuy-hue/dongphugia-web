import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PublicCartRoute from './page'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND') } }))
vi.mock('@/components/cart/cart-page', () => ({
    CartPage: ({ isolatedCheckout }: { isolatedCheckout: boolean }) => <div>{isolatedCheckout ? 'Giỏ TEST' : 'Giỏ'}</div>,
}))

afterEach(() => vi.unstubAllEnvs())

describe('Public Worker cart', () => {
    it('mounts checkout in the isolated Staging app', () => {
        vi.stubEnv('APP_ENV', 'staging')
        vi.stubEnv('PREVIEW_TEST_DATABASE_ISOLATED', 'true')
        render(<PublicCartRoute />)
        expect(screen.getByText('Giỏ TEST')).toBeTruthy()
    })

    it.each(['production', 'staging'])('closes the route outside isolated checkout (%s)', environment => {
        vi.stubEnv('APP_ENV', environment)
        vi.stubEnv('PREVIEW_TEST_DATABASE_ISOLATED', environment === 'production' ? 'true' : 'false')
        expect(() => PublicCartRoute()).toThrow('NOT_FOUND')
    })
})
