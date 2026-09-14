"""Focused source-feed tests; no database or external service is contacted."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/ltp_shop_test")

from fastapi import HTTPException
from backend.routes.shop_export import require_shop_token, serialize_quote, signed_evidence


class ShopExportTests(unittest.TestCase):
    def test_inventory_or_missing_token_cannot_read_quotes(self):
        with patch.dict(os.environ, {"LTP_SHOP_QUOTE_EXPORT_TOKEN": "q" * 40}):
            require_shop_token("q" * 40)
            for token in (None, "inventory-token", "wrong"):
                with self.assertRaises(HTTPException) as error:
                    require_shop_token(token)
                self.assertEqual(error.exception.status_code, 401)
        with patch.dict(os.environ, {"LTP_SHOP_QUOTE_EXPORT_TOKEN": ""}):
            with self.assertRaises(HTTPException) as error:
                require_shop_token("anything")
            self.assertEqual(error.exception.status_code, 503)

    def test_manual_acceptance_does_not_count_as_signature(self):
        self.assertIsNone(signed_evidence([{"type": "status", "message": "accepted"}]))
        self.assertIsNone(signed_evidence([{"type": "client_accepted"}]))

    def test_export_excludes_financials_credentials_and_image_but_keeps_recall(self):
        signature = "data:image/png;base64," + "a" * 220
        quote = SimpleNamespace(
            id=7, status="draft", project_id=None, custom_name="Show", custom_start_date="",
            custom_end_date="", notes="Bring adapter", updated_at=datetime.now(timezone.utc),
            share_token="never-export", activity=[{"type": "client_accepted", "id": "ca1",
                "date": "2026-09-14", "time": "12:00", "signatureDataUrl": signature}],
            sections=[{"id": "s1", "label": "Lighting", "items": [
                {"id": "l1", "type": "equipment", "name": "Light", "qty": 8,
                 "equipmentId": 12, "unitPrice": 500, "adjustedPrice": 400},
                {"id": "l2", "type": "service", "name": "Labour", "qty": 1},
            ]}],
        )
        payload = serialize_quote(quote, None)
        self.assertEqual(payload["status"], "draft")
        self.assertEqual(len(payload["sections"][0]["items"]), 1)
        self.assertNotIn("unitPrice", str(payload))
        self.assertNotIn("share_token", str(payload))
        self.assertNotIn(signature, str(payload))
        self.assertEqual(len(payload["signedEvidence"]["signatureSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
