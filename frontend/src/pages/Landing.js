import Navbar from '@/components/landing/Navbar';
import Hero from '@/components/landing/Hero';
import Products from '@/components/landing/Products';
import Features from '@/components/landing/Features';
import Audience from '@/components/landing/Audience';
import Steps from '@/components/landing/Steps';
import PaymentMethods from '@/components/landing/PaymentMethods';
import Stats from '@/components/landing/Stats';
import Security from '@/components/landing/Security';
import Policy from '@/components/landing/Policy';
import CTA from '@/components/landing/CTA';
import Footer from '@/components/landing/Footer';

export default function Landing() {
  return (
    <div className="bt-page" data-testid="landing-page">
      <Navbar />
      <Hero />
      <Products />
      <Features />
      <Audience />
      <Steps />
      <PaymentMethods />
      <Stats />
      <Security />
      <Policy />
      <CTA />
      <Footer />
    </div>
  );
}
