from __future__ import annotations

import base64
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from chat_documents import add_document_context, document_ids, read_document_source, retrieve_passages, store_document


def pdf_with_pages(*contents: str) -> bytes:
    writer = PdfWriter()
    for text in contents:
        page = writer.add_blank_page(612, 792)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii"))
        page.replace_contents(stream)
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def docx_with_text(text: str) -> bytes:
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("word/document.xml",
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                         f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>")
    return result.getvalue()


class ChatDocumentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def attach(self, name, data):
        document = store_document(self.root, name, base64.b64encode(data).decode("ascii"))
        return document

    def test_text_word_and_markdown_extract_and_duplicate_upload_is_idempotent(self):
        candidates = [
            ("Notes.txt", "The dial is copper.".encode("utf-16"), "dial is copper"),
            ("Readme.md", b"## Beacon\nThe signal is amber.", "signal is amber"),
            ("Guide.docx", docx_with_text("The call sign is Alder."), "call sign is Alder"),
        ]
        for name, bytes_, phrase in candidates:
            with self.subTest(name=name):
                document = self.attach(name, bytes_)
                self.assertEqual(document, self.attach(name, bytes_))
                passages = retrieve_passages(self.root, [document["id"]], [{"role": "user", "content": "Summarize"}], 8192)
                self.assertIn(phrase, passages[0]["text"])
        self.assertEqual(len(list(self.root.iterdir())), 3)

    def test_long_pdf_retrieval_uses_current_and_prior_questions_and_page_labels(self):
        padding = ["Generic receiving policies and warehouse labels. " * 25] * 26
        relevant = "The Zircon intake code is ZY-4179. Its call coordinator is Mara Bell."
        document = self.attach("Workshop.pdf", pdf_with_pages(*padding, relevant))
        question = [
            {"role": "user", "content": "What is the Zircon intake code?"},
            {"role": "assistant", "content": "It is ZY-4179."},
            {"role": "user", "content": "And who is the coordinator?"},
        ]
        passages = retrieve_passages(self.root, document_ids([document["id"]]), question, 4096)
        self.assertEqual(passages[0]["location"], "Page 27")
        self.assertIn("Mara Bell", passages[0]["text"])
        def measure(turns):
            return sum(len(turn["content"]) for turn in turns)
        messages, sources, cost = add_document_context(question, passages, 790, measure, chars_per_unit=1)
        self.assertEqual(messages[:2], question[:2])
        self.assertIn("Mara Bell", messages[-1]["content"])
        self.assertIn("as quoted data", messages[-1]["content"])
        self.assertEqual(sources[0]["location"], "Page 27")
        reference = sources[0]["reference"]
        self.assertEqual(reference["documentId"], document["id"])
        preview = read_document_source(self.root, document["id"], reference["passageIndex"],
                                       reference["quotedCharacters"], reference["fingerprint"])
        self.assertIn("Mara Bell", preview["quoted"])
        self.assertEqual(preview["before"]["location"], "Page 26")
        self.assertIsNone(preview["after"])
        self.assertLessEqual(cost, 790)
        self.assertEqual(question[-1]["content"], "And who is the coordinator?")

    def test_preview_keeps_exact_quoted_characters_and_rejects_a_different_source(self):
        phrase = "Room Cedar opens at noon. The schedule lists a forum. "
        document = self.attach("Schedule.txt", (phrase * 25 + "Follow-up discussion.").encode())
        other = self.attach("Schedule.txt", b"A newer schedule for a different event.")
        question = [{"role": "user", "content": "What is the schedule?"}]
        passages = retrieve_passages(self.root, [document["id"]], question, 4096)
        grounded, sources, _ = add_document_context(question, passages, 1300,
            lambda turns: len(turns[-1]["content"]), chars_per_unit=1)
        reference = sources[0]["reference"]
        args = (reference["passageIndex"], reference["quotedCharacters"], reference["fingerprint"])
        preview = read_document_source(self.root, reference["documentId"], *args)
        self.assertIn(preview["quoted"] + "\n--- End of excerpts ---", grounded[-1]["content"])
        self.assertTrue(preview["remaining"])
        self.assertEqual(preview["quoted"] + preview["remaining"], passages[0]["text"])
        self.assertIsNone(read_document_source(self.root, other["id"], *args))
        (self.root / f"{document['id']}.json").unlink()
        self.assertIsNone(read_document_source(self.root, document["id"], *args))

    def test_bad_file_and_missing_document_errors_are_actionable(self):
        for name, data, error in (
            ("../../private.txt", b"text", "valid filename"),
            ("bad.txt", b"\0\0\0", "readable text"),
            ("bad.docx", b"broken file", "Word document"),
            ("blank.pdf", pdf_with_pages(""), "selectable text"),
        ):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, error):
                self.attach(name, data)
        with self.assertRaisesRegex(ValueError, "saved documents"):
            document_ids(["../not-a-document"])
        with self.assertRaisesRegex(ValueError, "attached document is missing"):
            retrieve_passages(self.root, ["doc-" + "a" * 64], [{"role": "user", "content": "Look up policy"}], 8192)

    def test_retrieval_names_all_unavailable_ids_and_same_file_repairs_corrupt_record(self):
        good = self.attach("Overview.txt", b"Meet on Monday.")
        missing = self.attach("Schedule.txt", b"The workshop begins at noon.")
        damaged = self.attach("Address.txt", b"Use the east entrance.")
        (self.root / f"{missing['id']}.json").unlink()
        (self.root / f"{damaged['id']}.json").write_text('{"document": {}, "passages": [null]}', encoding="utf-8")
        ids = [document["id"] for document in (good, missing, damaged)]
        messages = [{"role": "user", "content": "When and where should I go?"}]

        with self.assertRaises(ValueError) as failure:
            retrieve_passages(self.root, ids, messages, 8192)
        self.assertEqual(failure.exception.document_ids, [missing["id"], damaged["id"]])
        self.assertEqual(self.attach("Schedule.txt", b"The workshop begins at noon."), missing)
        self.assertEqual(self.attach("Address.txt", b"Use the east entrance."), damaged)
        self.assertEqual([item["name"] for item in retrieve_passages(self.root, ids, messages, 8192)],
                         ["Overview.txt", "Schedule.txt", "Address.txt"])
