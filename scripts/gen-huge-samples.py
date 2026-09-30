# editor/samples/huge-*.md を書き出す (python3 scripts/gen-huge-samples.py)。大きな文書で枠の配置が崩れないかを確かめる e2e (e2e/frames-large.spec.ts) の入力にもなる
import os
OUT='editor/samples'
PALETTE=['#E8833A','#3B7DD8','#8A5FC2','#2E9E6B','#D64545','#E0A100','#0E8FA3','#C2409A','#6B7280','#9A8500','#4B55C4','#8C5A3C']
def col(i): return PALETTE[i%len(PALETTE)]

def groups_yaml(groups):
    out=['    groups:']
    for gid,label,color,boundary in groups:
        out.append(f'        {gid}:')
        out.append(f'            label: {label}')
        out.append(f'            color: "{color}"')
        if boundary: out.append('            boundary: true')
    return out

def rel_yaml(rel):
    out=['    relations:']
    for kind in ['chain','fork','join','depends']:
        if rel.get(kind):
            out.append(f'        {kind}:')
            out += [f'            - {x}' for x in rel[kind]]
    return out

def write(name,title,head,body):
    text='---\n'+f'title: "{title}"\n'+'markdag:\n'+'\n'.join(head)+'\n---\n\n'+'\n'.join(body)+'\n'
    open(os.path.join(OUT,name),'w').write(text)
    nodes=sum(1 for l in body if l.startswith('#') or l.lstrip().startswith('- '))
    print(name, 'nodes', nodes)

# ---------- 1: 組織の 3 段 (部門 > チーム > 機能) ----------
depts=[('購買体験部','buy',['商品探索','カート','決済']),
       ('会員基盤部','member',['認証','会員情報','ポイント']),
       ('物流部','logi',['在庫','配送','返品']),
       ('データ部','data',['計測','推薦','BI'])]
features={
 '商品探索':['検索','カテゴリ','ランキング'],'カート':['カート画面','クーポン','在庫引当'],'決済':['カード決済','後払い','領収書'],
 '認証':['ログイン','多要素認証','パスワード再設定'],'会員情報':['プロフィール','住所録','退会'],'ポイント':['付与','失効','交換'],
 '在庫':['入荷','棚卸','引当API'],'配送':['配送業者連携','追跡','日時指定'],'返品':['返品受付','返金','再入庫'],
 '計測':['イベント設計','タグ整備','ダッシュボード'],'推薦':['特徴量','モデル学習','ABテスト'],'BI':['売上集計','在庫分析','会員分析'],
}
tasks=['要件の整理','API設計','実装','テスト','リリース準備']
groups=[];body=['# EC サイト全面リニューアル','','## **リニューアル計画の承認** $plan','']
rel={'fork':[],'join':[],'depends':[],'chain':[]}
gi=0
done_terms=[]
for di,(dname,dkey,teams) in enumerate(depts):
    groups.append((dkey,dname,col(di),True)); body.append(f'## {dname} %{dkey}')
    for ti,team in enumerate(teams):
        tkey=f'{dkey}_t{ti}'; groups.append((tkey,f'{team}チーム',col(di+4+ti),True)); body.append(f'### {team} %{tkey}')
        for fi,feat in enumerate(features[team]):
            fkey=f'{tkey}_f{fi}'; groups.append((fkey,feat,col(di+ti+fi),True)); body.append(f'#### {feat} %{fkey}')
            for t in tasks: body.append(f'- {feat}の{t}')
            rel['chain'].append(' --> '.join(f'{feat}の{t}' for t in tasks))
            done_terms.append(f'{feat}のリリース準備')
    body.append('')
rel['fork'].append('$plan --> '+' & '.join(d for d,_,_ in depts))
# 部門をまたぐ依存
cross=[('ログインのAPI設計','カート画面の実装'),('引当APIの実装','在庫引当の実装'),('カード決済の実装','返金の実装'),
       ('イベント設計のリリース準備','ABテストの要件の整理'),('付与の実装','領収書の実装'),('住所録の実装','日時指定の実装'),
       ('検索の実装','特徴量の実装'),('売上集計のAPI設計','ランキングの実装'),('追跡のAPI設計','返品受付の実装'),
       ('多要素認証のテスト','後払いのテスト'),('在庫分析のAPI設計','棚卸の実装'),('退会の実装','失効の実装')]
rel['depends'] += [f'{a} --> {b}' for a,b in cross]
rel['join'].append(' & '.join(done_terms)+' --> $launch')
body += ['## **全機能のリリース** $launch','','## 公開後','- 障害対応の当番','- 利用状況の振り返り','- 次の四半期の計画']
rel['fork'].append('$launch --> 公開後/*')
head=['    legend:','        display: false']+rel_yaml(rel)+groups_yaml(groups)
write('huge-org.md','超大規模 1: 部門 > チーム > 機能 の 3 段の枠',head,body)

# ---------- 2: リージョン > 層 > コンポーネント の手順書 ----------
regions=['東京','大阪','シンガポール']
layers=[('ネットワーク',['VPC','サブネット','NAT','ロードバランサ']),
        ('データ',['主DB','レプリカ','キャッシュ','オブジェクトストレージ']),
        ('アプリ',['APIサーバ','ワーカー','バッチ','管理画面']),
        ('監視',['メトリクス','ログ','アラート','ダッシュボード'])]
steps=['作成','設定','疎通確認','切替']
groups=[];body=['# マルチリージョン基盤の移行','','## **移行開始** $start','']
rel={'chain':[],'fork':[],'join':[],'depends':[]}
prev='$start'
for ri,region in enumerate(regions):
    rkey=f'r{ri}'; groups.append((rkey,f'{region}リージョン',col(ri),True))
    body.append(f'## {region} %{rkey}')
    rel['chain'].append(f'{prev} --> {region}')
    prev_layer_last=None
    for li,(layer,comps) in enumerate(layers):
        lkey=f'{rkey}_l{li}'; groups.append((lkey,f'{region} {layer}',col(ri+li+3),True))
        body.append(f'### {layer} %{lkey}')
        lasts=[]
        for ci,comp in enumerate(comps):
            ckey=f'{lkey}_c{ci}'; groups.append((ckey,comp,col(ri+li+ci+6),True))
            body.append(f'#### {comp} %{ckey}')
            for st in steps: body.append(f'- [ ] {comp}の{st}')
            rel['chain'].append(' --> '.join(f'{region}/{comp}の{st}' for st in steps))
            lasts.append(f'{region}/{comp}の切替')
        if prev_layer_last:
            rel['join'].append(' & '.join(prev_layer_last)+f' --> {region}/{layer}')
        prev_layer_last=lasts
    ms=f'$done{ri}'
    body += ['',f'## **{region}の切替完了** {ms}','']
    rel['join'].append(' & '.join(prev_layer_last)+f' --> {ms}')
    prev=ms
    if ri>0:
        # 前のリージョンの主DB を複製元にする
        rel['depends'].append(f'{regions[ri-1]}/主DBの疎通確認 --> {region}/レプリカの作成')
body += ['## 旧基盤の撤去','- [ ] 旧DNSレコードの削除','- [ ] 旧DBの停止','- [ ] 旧ネットワークの削除','','## **移行完了** $end']
rel['chain'].append(f'{prev} --> 旧基盤の撤去')
rel['chain'].append('旧DNSレコードの削除 --> 旧DBの停止 --> 旧ネットワークの削除 --> $end')
head=['    legend:','        display: false','    tasks:',"        cycle: [' ', '/', 'x']"]+rel_yaml(rel)+groups_yaml(groups)
write('huge-regions.md','超大規模 2: リージョン > 層 > コンポーネント の手順書',head,body)

# ---------- 3: 事業部 > プロダクト > エピック + 横断グループ ----------
divs=[('コンシューマ事業部','cons',['家計簿アプリ','投資アプリ','保険比較']),
      ('法人事業部','corp',['経費精算','請求書発行','給与計算']),
      ('プラットフォーム事業部','plat',['共通認証','決済基盤','データ基盤'])]
epics=['オンボーディング刷新','性能改善','新機能']
stories=['ユーザー調査','仕様策定','デザイン','フロント実装','API実装','負荷試験','段階リリース']
people=[('alice','佐藤'),('bob','鈴木'),('carol','高橋'),('dave','田中')]
groups=[(k,v,col(i+7),False) for i,(k,v) in enumerate(people)]
groups.append(('sec','セキュリティ対応','#8B0000',True))
body=['# 年間プロダクトポートフォリオ','','## **年間計画の確定** $yplan','']
rel={'chain':[],'fork':[],'join':[],'depends':[]}
finals=[]
n=0
for di,(dname,dkey,prods) in enumerate(divs):
    groups.append((dkey,dname,col(di),True)); body.append(f'## {dname} %{dkey}')
    for pi,prod in enumerate(prods):
        pkey=f'{dkey}_p{pi}'; groups.append((pkey,prod,col(di+pi+3),True)); body.append(f'### {prod} %{pkey}')
        for ei,epic in enumerate(epics):
            ekey=f'{pkey}_e{ei}'; groups.append((ekey,epic,col(di+pi+ei+5),True)); body.append(f'#### {epic} %{ekey}')
            for si,st in enumerate(stories):
                person=people[(n+si)%len(people)][0]; mark=f' %{person}'
                if ei==1 and si in (4,5): mark+=' %sec'
                body.append(f'- {prod} {epic}の{st}{mark}')
            n+=1
            rel['chain'].append(' --> '.join(f'{prod} {epic}の{st}' for st in stories))
            finals.append(f'{prod} {epic}の段階リリース')
    body.append('')
rel['fork'].append('$yplan --> '+' & '.join(d for d,_,_ in divs))
# プラットフォームの成果を各プロダクトが使う
for prod in ['家計簿アプリ','投資アプリ','保険比較','経費精算','請求書発行','給与計算']:
    rel['depends'].append(f'共通認証 オンボーディング刷新のAPI実装 --> {prod} オンボーディング刷新のフロント実装')
for prod in ['投資アプリ','請求書発行','給与計算']:
    rel['depends'].append(f'決済基盤 新機能のAPI実装 --> {prod} 新機能のAPI実装')
for prod in ['家計簿アプリ','経費精算']:
    rel['depends'].append(f'データ基盤 性能改善の段階リリース --> {prod} 性能改善の負荷試験')
rel['join'].append(' & '.join(finals)+' --> $yend')
body += ['## **年度末の総括** $yend']
head=['    legend:','        display: false']+rel_yaml(rel)+groups_yaml(groups)
write('huge-portfolio.md','超大規模 3: 事業部 > プロダクト > エピック と横断グループ',head,body)
