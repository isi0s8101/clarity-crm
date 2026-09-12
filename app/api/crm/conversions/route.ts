import { NextRequest, NextResponse } from "next/server";

import {
  authErrorResponse,
  resolveAuthContext,
} from "@/lib/authz";
import {
  createCrmRecord,
  crmErrorResponse,
  getCrmRecord,
  updateCrmRecord,
} from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = (await request.json()) as Record<string, unknown>;
    const intent = typeof body.intent === "string" ? body.intent : "";

    if (intent === "lead-to-opportunity") {
      const leadId = text(body.leadId);
      const lead = await getCrmRecord(actor, leadId, "update");
      if (lead.type !== "lead") {
        return NextResponse.json({ error: "La source doit être un lead." }, { status: 400 });
      }

      let companyId = typeof lead.data.companyId === "string" ? lead.data.companyId : null;
      let contactId = typeof lead.data.contactId === "string" ? lead.data.contactId : null;

      const companyTitle = optionalText(body.companyTitle, 160);
      if (!companyId && companyTitle) {
        const company = await createCrmRecord(actor, {
          type: "company",
          title: companyTitle,
          data: { sourceLeadId: lead.id },
        });
        companyId = company.id;
      }

      const contactTitle = optionalText(body.contactTitle, 160);
      if (!contactId && contactTitle) {
        const contact = await createCrmRecord(actor, {
          type: "contact",
          title: contactTitle,
          data: {
            sourceLeadId: lead.id,
            ...(companyId ? { companyId } : {}),
            ...(typeof lead.data.email === "string" ? { email: lead.data.email } : {}),
            ...(typeof lead.data.phone === "string" ? { phone: lead.data.phone } : {}),
          },
        });
        contactId = contact.id;
      }

      const opportunityTitle = optionalText(body.opportunityTitle, 160) ?? lead.title;
      const amountCents = integerOrUndefined(body.amountCents);
      const probability = integerOrUndefined(body.probability);
      const stage = optionalText(body.stage, 40) ?? "qualification";
      const pipelineKey = optionalText(body.pipelineKey, 50);

      const opportunity = await createCrmRecord(actor, {
        type: "opportunity",
        title: opportunityTitle,
        data: {
          sourceLeadId: lead.id,
          ...(companyId ? { companyId } : {}),
          ...(contactId ? { contactId } : {}),
          ...(amountCents !== undefined ? { amountCents } : {}),
          ...(probability !== undefined ? { probability } : {}),
          stage,
          ...(pipelineKey ? { pipelineKey } : {}),
        },
      });

      const updatedLead = await updateCrmRecord(actor, lead.id, {
        status: "converted",
        data: {
          convertedOpportunityId: opportunity.id,
          ...(companyId ? { convertedCompanyId: companyId } : {}),
          ...(contactId ? { convertedContactId: contactId } : {}),
          convertedAt: new Date().toISOString(),
        },
      });

      return NextResponse.json({
        source: updatedLead,
        companyId,
        contactId,
        opportunity,
      });
    }

    if (intent === "quote-to-invoice") {
      const quoteId = text(body.quoteId);
      const quote = await getCrmRecord(actor, quoteId, "update");
      if (quote.type !== "quote") {
        return NextResponse.json({ error: "La source doit être un devis." }, { status: 400 });
      }
      const invoice = await createCrmRecord(actor, {
        type: "invoice",
        title: optionalText(body.invoiceTitle, 160) ?? `Facture · ${quote.title}`,
        data: {
          ...quote.data,
          quoteId: quote.id,
          sourceQuoteId: quote.id,
          issueDate: optionalText(body.issueDate, 10) ?? new Date().toISOString().slice(0, 10),
          ...(optionalText(body.dueDate, 10) ? { dueDate: optionalText(body.dueDate, 10) } : {}),
        },
      });
      const updatedQuote = await updateCrmRecord(actor, quote.id, {
        data: {
          convertedInvoiceId: invoice.id,
          invoiceConvertedAt: new Date().toISOString(),
        },
      });
      return NextResponse.json({ source: updatedQuote, invoice });
    }

    if (intent === "quote-to-contract") {
      const quoteId = text(body.quoteId);
      const quote = await getCrmRecord(actor, quoteId, "update");
      if (quote.type !== "quote") {
        return NextResponse.json({ error: "La source doit être un devis." }, { status: 400 });
      }
      const contract = await createCrmRecord(actor, {
        type: "contract",
        title: optionalText(body.contractTitle, 160) ?? `Contrat · ${quote.title}`,
        data: {
          quoteId: quote.id,
          sourceQuoteId: quote.id,
          ...(typeof quote.data.companyId === "string" ? { companyId: quote.data.companyId } : {}),
          ...(typeof quote.data.opportunityId === "string" ? { opportunityId: quote.data.opportunityId } : {}),
          ...(optionalText(body.startDate, 10) ? { startDate: optionalText(body.startDate, 10) } : {}),
          ...(optionalText(body.endDate, 10) ? { endDate: optionalText(body.endDate, 10) } : {}),
        },
      });
      const updatedQuote = await updateCrmRecord(actor, quote.id, {
        data: {
          convertedContractId: contract.id,
          contractConvertedAt: new Date().toISOString(),
        },
      });
      return NextResponse.json({ source: updatedQuote, contract });
    }

    return NextResponse.json({ error: "Conversion inconnue." }, { status: 400 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:conversion", error);
    return NextResponse.json({ error: "Conversion CRM impossible." }, { status: 503 });
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function integerOrUndefined(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
