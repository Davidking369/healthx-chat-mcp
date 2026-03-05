-- Runs automatically on first MySQL container startup
CREATE DATABASE IF NOT EXISTS healthx_db;
USE healthx_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  status ENUM('pending','processing','shipped','delivered') DEFAULT 'pending',
  amount DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Sample data
INSERT INTO users (name, email) VALUES
  ('Alice Johnson', 'alice@example.com'),
  ('Bob Smith', 'bob@example.com'),
  ('Carol White', 'carol@example.com');

INSERT INTO orders (user_id, status, amount) VALUES
  (1, 'delivered', 99.99),
  (2, 'pending', 149.00),
  (3, 'processing', 75.50);
