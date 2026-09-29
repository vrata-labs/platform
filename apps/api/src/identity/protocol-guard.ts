// Keep the released S2a body byte-identical until the protocol floor advances.
// Older S2a binaries reject the activated body on startup instead of serving v1.
export const legacyIdentityRoomGuard = `DECLARE bound boolean;
  BEGIN
    IF ROW(NEW.tenant_id, NEW.room_type, NEW.owner_participant_id, NEW.session_control)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.room_type, OLD.owner_participant_id, OLD.session_control) THEN
      EXECUTE format('select exists(select 1 from %I.room_identity_authority_v2 where tenant_id=$1 and room_id=$2)', TG_TABLE_SCHEMA)
        INTO bound USING OLD.tenant_id, OLD.room_id;
      IF bound THEN RAISE EXCEPTION 'room_identity_lifecycle_requires_v2' USING ERRCODE = '23514'; END IF;
    END IF;
    RETURN NEW;
  END;`;

export const activatedIdentityRoomGuard = `BEGIN
    IF ROW(NEW.tenant_id, NEW.room_type, NEW.owner_participant_id, NEW.session_control)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.room_type, OLD.owner_participant_id, OLD.session_control)
    THEN RAISE EXCEPTION 'room_identity_lifecycle_requires_v2' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;`;
