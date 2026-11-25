import { cn } from '@/lib/utils'

export function MegaSaleLink({ className, onClick }: { className?: string; onClick?: () => void }) {
    return (
        <a
            href="/uudaicuoinam2026/"
            onClick={onClick}
            className={cn(
                // The campaign header's gold CTA, with a touch-height target.
                'inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-transparent px-[14px] text-sm font-bold text-[#2b1e15]',
                'bg-[linear-gradient(180deg,#f4e2b0,#d4a957)] shadow-[0_6px_18px_rgba(212,169,87,.35)] hover:shadow-[0_8px_24px_rgba(212,169,87,.5)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b8873b]',
                className,
            )}
        >
            MEGA SALE
        </a>
    )
}
