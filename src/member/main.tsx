import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './member.css'
import { MemberPage } from './MemberPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemberPage />
  </StrictMode>,
)
