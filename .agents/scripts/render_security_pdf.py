from pathlib import Path
import fitz

src = Path('attached_assets/Biz-transPay_90_mesures_de_securite_1789399010304.pdf')
out = Path('.agents/outputs/biz-transpay-security-pages')
out.mkdir(parents=True, exist_ok=True)
doc = fitz.open(src)
print(f'pages={doc.page_count}')
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    path = out / f'page-{i+1}.png'
    pix.save(path)
    print(path)
