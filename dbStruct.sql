CREATE TABLE users(
    id BIGINT PRIMARY KEY,
    notify BOOLEAN DEFAULT true,
    format INT DEFAULT 0,
    group_name TEXT,
    query TEXT
);
