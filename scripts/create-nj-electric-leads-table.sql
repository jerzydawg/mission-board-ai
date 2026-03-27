-- Create NJ Electric leads table
CREATE TABLE IF NOT EXISTS nj_electric_leads (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(255),
  service VARCHAR(100),
  message TEXT,
  status VARCHAR(50) DEFAULT 'new',
  contacted_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_nj_electric_leads_updated_at
  BEFORE UPDATE ON nj_electric_leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_created_at ON nj_electric_leads(created_at);
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_status ON nj_electric_leads(status);
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_email ON nj_electric_leads(email);

-- Insert some sample data for testing (remove in production)
INSERT INTO nj_electric_leads (name, phone, email, service, message) VALUES
  ('Test Customer', '(732) 555-1234', 'test@example.com', 'electrical-repair', 'Testing the lead system')
ON CONFLICT DO NOTHING;