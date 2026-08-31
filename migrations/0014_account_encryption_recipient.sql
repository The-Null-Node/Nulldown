-- The browser pins this signing-key-authorized recipient before delegated authoring is allowed.
ALTER TABLE accounts ADD COLUMN encryption_kid TEXT;
ALTER TABLE accounts ADD COLUMN encryption_public_jwk TEXT;
