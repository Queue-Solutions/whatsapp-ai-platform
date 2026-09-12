import type { Metadata } from 'next';
export const metadata:Metadata={title:'Queue Solutions | Business Workspace',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body style={{fontFamily:'system-ui,sans-serif',margin:0,background:'#f6f8f7',color:'#182d27'}}>{children}</body></html>;
}
