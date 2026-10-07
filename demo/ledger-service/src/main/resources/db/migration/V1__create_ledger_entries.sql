CREATE TABLE ledger_entries (
    id          bigserial     PRIMARY KEY,
    payment_id  uuid          NOT NULL UNIQUE,
    merchant_id varchar(64)   NOT NULL,
    currency    varchar(3)    NOT NULL,
    amount      numeric(12,2) NOT NULL,
    settled_at  timestamptz   NOT NULL,
    booked_at   timestamptz   NOT NULL DEFAULT now()
);
