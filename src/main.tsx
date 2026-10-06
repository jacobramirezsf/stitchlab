import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Pathname routing, same scheme as the Bayside site these tools come from.
const StitchLabPage = lazy(() => import('./stitchlab/StitchLabPage.tsx'))
const StitchLabHome = lazy(() => import('./stitchlab/StitchLabHome.tsx'))
const AnimationHome = lazy(() => import('./stitchlab/AnimationHome.tsx'))
const CustomizerPage = lazy(() => import('./customizer/CustomizerPage.tsx'))
const LabPage = lazy(() => import('./customizer/LabPage.tsx'))

const path = window.location.pathname
const is = (re: RegExp) => re.test(path)
// /stitchlab?dev is the full test bench (file inspector, every experiment).
const stitchLabDev = new URLSearchParams(window.location.search).has('dev')

const LINKS: [string, string, string][] = [
  ['/stitchlab', 'Stitch Lab', 'Embroidery tools: generators, digitizing, lettering, DST/PES/JEF export'],
  ['/stitchlab?dev', 'Stitch Lab (dev bench)', 'Every tool and experiment, plus the file inspector'],
  ['/animation', 'Animation', 'Photo and stitch animation tools'],
  ['/customize', 'Customizer', 'Place designs on blank garments'],
  ['/lab', 'Customizer Lab', 'The full garment design lab'],
]

function Index() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '3rem 1rem', fontFamily: 'system-ui, sans-serif', color: '#1c1c1a' }}>
      <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 400 }}>Stitch Lab</h1>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '1rem' }}>
        {LINKS.map(([href, name, blurb]) => (
          <li key={href}>
            <a href={href} style={{ color: '#082870', fontWeight: 600 }}>{name}</a>
            <div style={{ color: '#78766f', fontSize: '0.9rem' }}>{blurb}</div>
          </li>
        ))}
      </ul>
    </main>
  )
}

const page = is(/^\/stitchlab\/?$/) ? (stitchLabDev ? <StitchLabPage /> : <StitchLabHome />)
  : is(/^\/animation\/?$/) ? <AnimationHome />
  : is(/^\/customize\/?$/) ? <CustomizerPage />
  : is(/^\/lab\/?$/) ? <LabPage />
  : is(/^\/makers\/?$/) ? <LabPage youth />
  : <Index />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{page}</Suspense>
  </StrictMode>,
)
