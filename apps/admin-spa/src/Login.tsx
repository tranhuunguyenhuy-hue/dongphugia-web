import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errorText, type User } from './api'
import { Alert, CTA } from './ui'

export function Login({ onDone }: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  return (
    <div className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">ĐPG</div>
          <span className="text-lg font-semibold tracking-tight">Đông Phú Gia</span>
        </div>
        <Card>
          <CardHeader className="text-center"><CardTitle className="text-xl">Đăng nhập quản trị</CardTitle><CardDescription>Dùng tài khoản nhân viên được cấp.</CardDescription></CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={async (e) => {
              e.preventDefault(); setBusy(true); setError('')
              try { onDone((await api.login(email, password)).user) } catch (err) { setError(errorText(err)); setBusy(false) }
            }}>
              <div className="grid gap-2"><Label htmlFor="login-email">Email</Label><Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
              <div className="grid gap-2"><Label htmlFor="login-password">Mật khẩu</Label><Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              {error && <Alert>{error}</Alert>}
              <Button className={CTA} disabled={busy}>{busy && <Loader2 className="animate-spin" />}{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">Khu vực nội bộ. Không dành cho khách hàng.</p>
      </div>
    </div>
  )
}
