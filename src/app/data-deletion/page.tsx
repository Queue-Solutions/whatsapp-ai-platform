import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Data Deletion | IRAM Jewelry WhatsApp Service',
  description: 'How to request deletion of data from the IRAM Jewelry WhatsApp customer service.',
  robots: { index: true, follow: true },
};

export default function DataDeletionPage() {
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
        <h1>Data Deletion Instructions</h1>
        <p className={styles.updated}>Effective and last updated: 11 November 2026</p>

        <p className={styles.summary}>
          You can ask IRAM Jewelry to delete or anonymize personal information held by its WhatsApp
          customer-support platform. There is no fee for making a request.
        </p>

        <section>
          <h2>How to submit a request</h2>
          <ol>
            <li>
              Email <a href="mailto:info@iramjewelry.com?subject=WhatsApp%20Data%20Deletion%20Request">
                info@iramjewelry.com
              </a> with the subject <strong>WhatsApp Data Deletion Request</strong>.
            </li>
            <li>Include the WhatsApp phone number used to contact IRAM Jewelry, in international format.</li>
            <li>Include the approximate date of your conversation so the correct record can be located.</li>
            <li>State whether you want all eligible support data deleted or only specific information.</li>
          </ol>
        </section>

        <section>
          <h2>Verification</h2>
          <p>
            IRAM Jewelry may send a confirmation through WhatsApp or email to make sure the requester
            controls the relevant account. Never send your WhatsApp password, one-time code, payment-card
            details or unrelated identity documents. Additional information will be requested only when
            reasonably necessary to verify ownership or satisfy a legal requirement.
          </p>
        </section>

        <section>
          <h2>What happens next</h2>
          <p>
            Once verified, eligible records held in the IRAM Jewelry support platform will be deleted or
            anonymized, and deletion will be passed to relevant service providers where appropriate.
            IRAM Jewelry aims to complete requests within 30 days, or within the period required by
            applicable law. A small amount of information may be retained when required for legal,
            security, fraud-prevention or dispute-resolution purposes.
          </p>
        </section>

        <div className={styles.notice}>
          <strong>Important:</strong> deleting support-platform data does not automatically erase the
          chat stored in your WhatsApp account, on your device or in Meta&apos;s systems. You can manage or
          delete your copy of the conversation separately inside WhatsApp. It also does not remove IRAM
          Jewelry&apos;s phone number from WhatsApp groups.
        </div>

        <section>
          <h2>Questions</h2>
          <p>
            For questions about the request process, contact{' '}
            <a href="mailto:info@iramjewelry.com">info@iramjewelry.com</a>. For more information about
            how the service handles data, read the <Link href="/privacy">privacy policy</Link>.
          </p>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>© 2026 IRAM Jewelry</span>
          <Link href="/privacy">Privacy policy</Link>
        </div>
      </footer>
    </div>
  );
}
