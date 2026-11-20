"use client"

import { useEffect, useRef, useState } from "react"
import styles from "./home-promotion.module.css"

const PROMOTION_URL = "https://www.dongphugia.vn/uudaicuoinam2026/"
const PROMOTION_IMAGE = "/images/campaigns/toto-year-end-2026.jpg"
const SESSION_KEY = "dpg:home-promotion:toto-year-end-2026"
let shownInDocument = false

function isPromotionUrl(value: string) {
    if (value !== value.trim() || /[\s\\]/.test(value)) return false
    if (value.startsWith("/")) return !value.startsWith("//") && value.length > 1

    if (!/^https:\/\/[^/]/.test(value)) return false

    try {
        const url = new URL(value)
        return Boolean(url.hostname) && !url.username && !url.password
    } catch {
        return false
    }
}

function hasShownPromotion() {
    if (shownInDocument) return true
    try {
        return sessionStorage.getItem(SESSION_KEY) === "1"
    } catch {
        return false
    }
}

function markPromotionShown() {
    shownInDocument = true
    try {
        sessionStorage.setItem(SESSION_KEY, "1")
    } catch {
        // A document-level guard still covers client-side navigation.
    }
}

export function HomePromotion({
    image = PROMOTION_IMAGE,
    destination = PROMOTION_URL,
}: {
    image?: string | null
    destination?: string
} = {}) {
    const dialogRef = useRef<HTMLDialogElement>(null)
    const restoreScroll = useRef<(() => void) | null>(null)
    const [ready, setReady] = useState(false)
    const enabled = Boolean(image && isPromotionUrl(destination))

    useEffect(() => {
        if (!enabled || hasShownPromotion()) return

        const prepare = () => setReady(true)
        if (document.readyState === "complete") prepare()
        else window.addEventListener("load", prepare, { once: true })

        return () => {
            window.removeEventListener("load", prepare)
            restoreScroll.current?.()
        }
    }, [enabled])

    if (!ready || !image || !enabled) return null

    function openAfterImageLoad() {
        const dialog = dialogRef.current
        if (!dialog?.showModal || hasShownPromotion()) return

        dialog.showModal()
        const root = document.documentElement
        const previousOverflow = root.style.overflow
        root.style.overflow = "hidden"
        restoreScroll.current = () => {
            root.style.overflow = previousOverflow
            restoreScroll.current = null
        }
        markPromotionShown()
    }

    return (
        <dialog
            ref={dialogRef}
            className={styles.dialog}
            aria-label="Khuyến mãi TOTO cuối năm"
            onClose={() => restoreScroll.current?.()}
            onClick={(event) => {
                if (event.target === event.currentTarget) event.currentTarget.close()
            }}
        >
            <button
                type="button"
                className={styles.close}
                aria-label="Đóng khuyến mãi"
                onClick={() => dialogRef.current?.close()}
            >
                <span aria-hidden="true">×</span>
            </button>
            <a className={styles.imageLink} href={destination}>
                {/* Static campaign JPEG served directly, without an image service. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={image}
                    alt="Xem chi tiết chương trình Tri ân cuối năm – Mega Sale TOTO tại Đông Phú Gia"
                    width={1080}
                    height={1080}
                    fetchPriority="low"
                    onLoad={openAfterImageLoad}
                />
            </a>
        </dialog>
    )
}
