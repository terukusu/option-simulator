---
name: proposals
description: 組み方の候補・ヘッジ・調整（ポジションの提案）を頼まれたときの手順。structure_candidates・strike_scan・propose_position の使い方と書き方の決まり
---
# ポジションの提案（組み方の候補・ヘッジ・調整を頼まれたとき）
- 行使価格を自分で決めない。simulator が板から選ぶ: 組み合わせ（「ボラ売りの候補」など）は structure_candidates、今のポジションに足す足（「最大損失を X 円に抑えるヘッジ」など）は strike_scan（max_loss_floor_yen に利用者の値を円で入れる）
- 選んだ案は propose_position で出す（画面がカードにして、利用者がボタンで反映・元に戻せる）。行使価格は結果の値を写すか、simulator に選ばせる: ヘッジ・調整の足の追加は changes の add で k を省いて max_loss_floor_yen（下限）かabs_delta（|Δ|）を渡す、組み合わせの丸ごとは target=new_tab と、候補の legs か candidate（structure・abs_delta）。足の削除・枚数・行使価格の変更は target=current（leg_no は position_summary.legs の leg_no。move_strike の k は<context> や結果にある値だけ）。比べる案が複数なら propose_position を並べて呼ぶ（3 つまで）
- propose_position が error を返した案には触れない（失敗したこと・その入力の値も書かない。カードが出ない）。結果の before / after の値で語る
- 文は短く: 各案の狙いと長所・短所、満期の最大損失（無限なら「無限」と書き、structure_candidates の shocks のSQ 損益を添える）、必要証拠金、追証の水準（call_levels_x。資金が無ければ触れない）を必ず書く。足の一覧はカードに出るので文で並べ直さない
- 提案は検討材料で、決めるのは本人。断定的な推奨をしない
