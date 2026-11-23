import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ search: new URLSearchParams('brand=toto'), push: vi.fn() }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/thiet-bi-ve-sinh/bon-cau',
  useSearchParams: () => mocks.search,
  useRouter: () => ({ push: mocks.push }),
}))

import { CategorySort } from './preview-sort'

describe('Preview CategorySort (#447)', () => {
  beforeEach(() => { mocks.push.mockReset(); window.history.replaceState(null, '', '/thiet-bi-ve-sinh/bon-cau?brand=toto'); vi.restoreAllMocks() })

  it('with serverSort it navigates through the Next router so the server list re-renders, keeping other filters and resetting the page', () => {
    render(<CategorySort serverSort />)
    fireEvent.change(screen.getByLabelText('Sắp xếp sản phẩm'), { target: { value: 'price-asc' } })
    expect(mocks.push).toHaveBeenCalledWith('/thiet-bi-ve-sinh/bon-cau?brand=toto&sort=price-asc&page=1', { scroll: false })
  })
  it('selecting the default removes sort', () => {
    window.history.replaceState(null, '', '/thiet-bi-ve-sinh/bon-cau?brand=toto&sort=price-desc&page=3')
    render(<CategorySort serverSort />)
    fireEvent.change(screen.getByLabelText('Sắp xếp sản phẩm'), { target: { value: 'default' } })
    expect(mocks.push).toHaveBeenCalledWith('/thiet-bi-ve-sinh/bon-cau?brand=toto&page=1', { scroll: false })
  })
  it('without serverSort the client-only behaviour is unchanged (no router navigation)', () => {
    const push = vi.spyOn(window.history, 'pushState')
    render(<CategorySort />)
    fireEvent.change(screen.getByLabelText('Sắp xếp sản phẩm'), { target: { value: 'price-desc' } })
    expect(mocks.push).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledOnce()
  })
})
