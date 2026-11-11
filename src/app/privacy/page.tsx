import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Privacy Policy | IRAM Jewelry WhatsApp Service',
  description: 'Privacy information for the IRAM Jewelry WhatsApp customer service.',
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/privacy">IRAM JEWELRY</Link>
          <nav className={styles.nav} aria-label="Legal pages">
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/data-deletion">Data deletion</Link>
          </nav>
        </div>
      </header>

      <main className={styles.article}>
        <p className={styles.eyebrow}>WhatsApp customer service</p>
        <h1>Privacy Policy</h1>
        <p className={styles.updated}>Effective and last updated: 11 November 2026</p>

        <p className={styles.summary}>
          This policy explains how IRAM Jewelry handles information when customers contact its
          WhatsApp customer service. Queue Solutions operates the customer-support platform for
          IRAM Jewelry as a service provider.
        </p>

        <section>
          <h2>1. Who is responsible for your information</h2>
          <p>
            IRAM Jewelry is responsible for the customer information used through this service.
            Its business address is 10 Nazih Khalifa, El-Montaza, Heliopolis, Cairo, Egypt. You can
            contact IRAM Jewelry at <a href="mailto:info@iramjewelry.com">info@iramjewelry.com</a>
            {' '}or visit <a href="https://iramjewelry.com/">iramjewelry.com</a>.
          </p>
          <p>
            Queue Solutions supplies and operates the WhatsApp customer-support platform on IRAM
            Jewelry&apos;s behalf and processes information only to provide, protect and improve that
            service.
          </p>
        </section>

        <section>
          <h2>2. Information we process</h2>
          <ul>
            <li>Your WhatsApp phone number, name and profile information made available by WhatsApp.</li>
            <li>Messages, images, documents or other content you choose to send to IRAM Jewelry.</li>
            <li>Message timestamps and delivery, read and conversation-status information.</li>
            <li>Support details such as the topic of your request, complaint or human-agent handoff.</li>
            <li>Limited technical and security records needed to prevent abuse and maintain the service.</li>
          </ul>
          <p>Please do not send passwords, one-time codes or payment-card details in WhatsApp messages.</p>
        </section>

        <section>
          <h2>3. How the information is used</h2>
          <ul>
            <li>To receive and respond to customer questions and service requests.</li>
            <li>To provide automated assistance and route conversations to IRAM Jewelry staff when needed.</li>
            <li>To handle complaints, maintenance, exchanges, returns and branch-related questions.</li>
            <li>To maintain service reliability, prevent fraud or abuse and diagnose technical problems.</li>
            <li>To understand service performance and improve customer support.</li>
          </ul>
        </section>

        <section>
          <h2>4. Automated assistance</h2>
          <p>
            IRAM Jewelry may use an automated assistant to help answer WhatsApp messages. Relevant
            message content may be processed by contracted artificial-intelligence providers solely
            to generate or support a response, apply safety controls and operate the service. A human
            representative can take over a conversation when needed.
          </p>
        </section>

        <section>
          <h2>5. When information is shared</h2>
          <p>Information is shared only as reasonably necessary with:</p>
          <ul>
            <li>Meta and WhatsApp, which deliver the messaging service.</li>
            <li>Queue Solutions, which operates the customer-support platform for IRAM Jewelry.</li>
            <li>Contracted hosting, database, security and artificial-intelligence service providers.</li>
            <li>Authorities or professional advisers when required by law or needed to protect legal rights.</li>
          </ul>
          <p>IRAM Jewelry and Queue Solutions do not sell customer personal information.</p>
        </section>

        <section>
          <h2>6. Retention and security</h2>
          <p>
            Customer-support information is kept only for as long as reasonably needed to provide
            support, maintain business and security records, resolve disputes and comply with legal
            obligations. It is then deleted or anonymized where appropriate. Reasonable technical and
            organizational safeguards are used to protect the information, but no online service can
            guarantee absolute security.
          </p>
        </section>

        <section>
          <h2>7. International processing</h2>
          <p>
            WhatsApp and the contracted technology providers may process information in countries
            other than Egypt. Appropriate contractual and security safeguards are used where required.
          </p>
        </section>

        <section>
          <h2>8. Your choices and rights</h2>
          <p>
            Subject to applicable law, you may ask to access, correct or delete information connected
            with your WhatsApp conversation, or object to certain uses. See the{' '}
            <Link href="/data-deletion">data deletion instructions</Link> for the simplest way to make
            a request. You may also stop messaging IRAM Jewelry or block the business in WhatsApp.
          </p>
        </section>

        <section>
          <h2>9. Children</h2>
          <p>
            This customer-support service is not directed to children under 13. A parent or guardian
            should contact IRAM Jewelry if a child has provided personal information through the service.
          </p>
        </section>

        <section>
          <h2>10. Updates and contact</h2>
          <p>
            This policy may be updated when the service or legal requirements change. The current
            version and its effective date will remain available on this page. Questions may be sent
            to <a href="mailto:info@iramjewelry.com">info@iramjewelry.com</a>.
          </p>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>© 2026 IRAM Jewelry</span>
          <Link href="/data-deletion">Request data deletion</Link>
        </div>
      </footer>
    </div>
  );
}
